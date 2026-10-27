
"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

// ======================================================
// AI SIGNAL RADAR - TWELVE DATA
// Forex / Non-OTC / 1-minute candles
// Reference market data only; not IQ Option OTC prices
// ======================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";

// ค่าเริ่มต้น 15 นาที เพื่อช่วยควบคุมโควตา API ฟรี
// ปรับได้ใน Render Environment Variables
const POLL_INTERVAL_MS = Math.max(
  60000,
  Number(process.env.POLL_INTERVAL_MS || 900000)
);

const MIN_CANDLES = 100;
const MIN_SCORE = 70;
const MIN_AGREEMENT = 0.60;
const STALE_AFTER_MS = 4 * 60 * 1000;

const PAIRS = [
  { symbol: "EUR/USD", name: "EUR/USD" },
  { symbol: "GBP/USD", name: "GBP/USD" },
  { symbol: "USD/JPY", name: "USD/JPY" },
  { symbol: "AUD/USD", name: "AUD/USD" },
  { symbol: "USD/CAD", name: "USD/CAD" },
  { symbol: "NZD/USD", name: "NZD/USD" },
  { symbol: "EUR/GBP", name: "EUR/GBP" }
];

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// STATE
// ======================================================

const state = {
  symbol: "EUR/USD",
  timeframe: "1min",
  signal: "STANDBY",
  score: 0,
  confidence: 0,
  price: null,
  candleTime: null,
  updatedAt: null,
  dataStatus: "WAITING",
  reason: "รอข้อมูลตลาด",
  indicators: {},
  threshold: MIN_SCORE
};

const pairsCache = new Map();

for (const pair of PAIRS) {
  pairsCache.set(pair.symbol, {
    symbol: pair.symbol,
    name: pair.name,
    signal: "STANDBY",
    score: 0,
    confidence: 0,
    price: null,
    candleTime: null,
    updatedAt: null,
    dataStatus: "WAITING",
    reason: "รอสแกนข้อมูล",
    indicators: {}
  });
}

let activeClients = 0;
let scanInProgress = false;
let scanTimer = null;
let lastScanAt = null;
let lastError = null;

// ======================================================
// UTILITIES
// ======================================================

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(
    mean(values.map(value => (value - avg) ** 2))
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function validNumber(value) {
  return Number.isFinite(value);
}

function utcDateTime(value) {
  if (!value) return null;

  // Twelve Data is requested with timezone=UTC.
  const normalized = String(value).trim().replace(" ", "T");
  const result = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)
      ? normalized
      : `${normalized}Z`
  );

  return Number.isFinite(result) ? result : null;
}

function getPair(symbol) {
  return PAIRS.find(
    pair => pair.symbol.toUpperCase() === String(symbol || "").toUpperCase()
  );
}

// ======================================================
// TWELVE DATA - REST API
// API KEY remains server-side
// ======================================================

async function fetchCandles(symbol) {
  if (!API_KEY) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render"
    );
  }

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "200");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Twelve Data ตอบกลับช้าเกินกำหนด");
    }
    throw new Error("เชื่อมต่อ Twelve Data ไม่สำเร็จ");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const body = await response.json();

  if (body.status === "error" || body.code || body.message && !body.values) {
    throw new Error(
      String(body.message || body.code || "Twelve Data API error")
        .slice(0, 220)
    );
  }

  if (!Array.isArray(body.values)) {
    throw new Error("API ไม่ส่งข้อมูลแท่งเทียนกลับมา");
  }

  const candles = body.values
    .map(item => ({
      time: utcDateTime(item.datetime),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume || 0)
    }))
    .filter(candle =>
      candle.time !== null &&
      validNumber(candle.open) &&
      validNumber(candle.high) &&
      validNumber(candle.low) &&
      validNumber(candle.close) &&
      candle.open > 0 &&
      candle.high >= candle.low &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close)
    )
    .sort((a, b) => a.time - b.time);

  // Remove duplicate candle timestamps.
  const unique = new Map();
  for (const candle of candles) unique.set(candle.time, candle);

  return [...unique.values()];
}

// ======================================================
// TECHNICAL INDICATORS
// ======================================================

function emaSeries(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;

  let current = mean(values.slice(0, period));
  output[period - 1] = current;

  const alpha = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    current = values[i] * alpha + current * (1 - alpha);
    output[i] = current;
  }

  return output;
}

function rsiSeries(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  output[period] = avgLoss === 0
    ? (avgGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain = (
      avgGain * (period - 1) + Math.max(0, change)
    ) / period;

    avgLoss = (
      avgLoss * (period - 1) + Math.max(0, -change)
    ) / period;

    output[i] = avgLoss === 0
      ? (avgGain === 0 ? 50 : 100)
      : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return output;
}

function atrSeries(candles, period = 14) {
  const tr = candles.map((candle, i) => {
    if (i === 0) return candle.high - candle.low;

    const previousClose = candles[i - 1].close;

    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });

  const output = Array(candles.length).fill(null);
  if (tr.length < period) return output;

  let current = mean(tr.slice(0, period));
  output[period - 1] = current;

  for (let i = period; i < tr.length; i++) {
    current = (current * (period - 1) + tr[i]) / period;
    output[i] = current;
  }

  return output;
}

function adxValue(candles, period = 14) {
  if (candles.length < period * 2 + 2) return null;

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const up = current.high - previous.high;
    const down = previous.low - current.low;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);

    trs.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  let tr = mean(trs.slice(0, period));
  let plus = mean(plusDM.slice(0, period));
  let minus = mean(minusDM.slice(0, period));

  const dxValues = [];

  for (let i = period; i < trs.length; i++) {
    if (i > period) {
      tr = (tr * (period - 1) + trs[i]) / period;
      plus = (plus * (period - 1) + plusDM[i]) / period;
      minus = (minus * (period - 1) + minusDM[i]) / period;
    }

    const plusDI = tr ? 100 * plus / tr : 0;
    const minusDI = tr ? 100 * minus / tr : 0;
    const denominator = plusDI + minusDI;

    dxValues.push(
      denominator ? 100 * Math.abs(plusDI - minusDI) / denominator : 0
    );
  }

  if (dxValues.length < period) return null;

  let adx = mean(dxValues.slice(0, period));

  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

function stochasticValue(candles, period = 14) {
  if (candles.length < period) return null;

  const recent = candles.slice(-period);
  const highest = Math.max(...recent.map(c => c.high));
  const lowest = Math.min(...recent.map(c => c.low));
  const close = candles[candles.length - 1].close;

  if (highest === lowest) return 50;

  return 100 * (close - lowest) / (highest - lowest);
}

function bollingerValue(closes, period = 20) {
  if (closes.length < period) return null;

  const recent = closes.slice(-period);
  const middle = mean(recent);
  const deviation = stddev(recent);

  return {
    upper: middle + 2 * deviation,
    middle,
    lower: middle - 2 * deviation
  };
}

// ======================================================
// MULTI-INDICATOR SIGNAL ENGINE
// CALL / PUT / STANDBY
// ======================================================

function analyzeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    throw new Error(`ต้องมีข้อมูลอย่างน้อย ${MIN_CANDLES} แท่ง`);
  }

  const closes = candles.map(c => c.close);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema5 = emaSeries(closes, 5);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  const ema100 = emaSeries(closes, 100);

  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(candles, 14);
  const macdFast = emaSeries(closes, 12);
  const macdSlow = emaSeries(closes, 26);

  const macdLine = closes.map((_, i) =>
    macdFast[i] !== null && macdSlow[i] !== null
      ? macdFast[i] - macdSlow[i]
      : null
  );

  const validMacd = macdLine.filter(Number.isFinite);
  const macdSignalSeries = emaSeries(validMacd, 9);
  const macdLineLast = macdLine[macdLine.length - 1];
  const macdLinePrevious = macdLine[macdLine.length - 2];
  const macdSignal = macdSignalSeries[macdSignalSeries.length - 1];

  const atrNow = atr[atr.length - 1];
  const atrPrevious = atr[atr.length - 5] ?? atrNow;
  const rsiNow = rsi[rsi.length - 1];
  const bands = bollingerValue(closes, 20);
  const adx = adxValue(candles, 14);
  const stochastic = stochasticValue(candles, 14);

  const values = [
    ema5.at(-1), ema9.at(-1), ema21.at(-1),
    ema50.at(-1), ema100.at(-1),
    rsiNow, atrNow, macdLineLast, macdSignal, stochastic
  ];

  if (!values.every(Number.isFinite) || !bands) {
    throw new Error("คำนวณตัวชี้วัดไม่สำเร็จ");
  }

  let bullish = 0;
  let bearish = 0;
  const reasons = [];

  function vote(conditionUp, conditionDown, weight, label) {
    if (conditionUp) {
      bullish += weight;
      reasons.push(`${label}: ขาขึ้น`);
    } else if (conditionDown) {
      bearish += weight;
      reasons.push(`${label}: ขาลง`);
    }
  }

  // Trend structure
  vote(
    ema5.at(-1) > ema9.at(-1) && ema9.at(-1) > ema21.at(-1),
    ema5.at(-1) < ema9.at(-1) && ema9.at(-1) < ema21.at(-1),
    2,
    "EMA 5/9/21"
  );

  vote(
    ema21.at(-1) > ema50.at(-1),
    ema21.at(-1) < ema50.at(-1),
    2,
    "EMA 21/50"
  );

  vote(
    latest.close > ema100.at(-1),
    latest.close < ema100.at(-1),
    2,
    "EMA 100"
  );

  // Momentum
  vote(rsiNow >= 52 && rsiNow < 70, rsiNow <= 48 && rsiNow > 30, 1.5, "RSI");

  vote(
    macdLineLast > macdSignal && macdLineLast > macdLinePrevious,
    macdLineLast < macdSignal && macdLineLast < macdLinePrevious,
    2,
    "MACD"
  );

  vote(
    stochastic > 50 && stochastic < 80,
    stochastic < 50 && stochastic > 20,
    1,
    "Stochastic"
  );

  // Latest candle momentum
  vote(
    latest.close > latest.open && latest.close > previous.close,
    latest.close < latest.open && latest.close < previous.close,
    1,
    "Price action"
  );

  // Bollinger location
  vote(
    latest.close > bands.middle,
    latest.close < bands.middle,
    1,
    "Bollinger"
  );

  const totalVotes = bullish + bearish;
  const winningVotes = Math.max(bullish, bearish);
  const score = totalVotes > 0
    ? Math.round(100 * winningVotes / totalVotes)
    : 0;

  const agreement = totalVotes > 0
    ? winningVotes / totalVotes
    : 0;

  const volatilityRatio = atrPrevious > 0
    ? atrNow / atrPrevious
    : 1;

  const trendStrength = adx === null ? "UNKNOWN"
    : adx >= 25 ? "STRONG"
    : adx >= 18 ? "MODERATE"
    : "WEAK";

  let signal = "STANDBY";
  let reason = "ตัวชี้วัดยังไม่ยืนยันไปในทิศทางเดียวกัน";

  const latestAge = Date.now() - latest.time;
  const candleFresh = latestAge >= -60000 &&
    latestAge <= STALE_AFTER_MS;

  if (!candleFresh) {
    reason = "ข้อมูลแท่งเทียนเก่าหรือเวลาไม่ตรง";
  } else if (volatilityRatio > 3) {
    reason = "ความผันผวนสูงผิดปกติ";
  } else if (adx !== null && adx < 12) {
    reason = "แนวโน้มอ่อนมาก ตลาดอาจแกว่งตัว";
  } else if (score < MIN_SCORE || agreement < MIN_AGREEMENT) {
    reason = "คะแนนหรือความเห็นตัวชี้วัดไม่ถึงเกณฑ์";
  } else if (bullish > bearish && rsiNow < 70) {
    signal = "CALL";
    reason = "แนวโน้มและโมเมนตัมเอนเอียงขึ้น";
  } else if (bearish > bullish && rsiNow > 30) {
    signal = "PUT";
    reason = "แนวโน้มและโมเมนตัมเอนเอียงลง";
  }

  return {
    signal,
    score,
    confidence: score,
    reason,
    indicators: {
      ema5: round(ema5.at(-1), 6),
      ema9: round(ema9.at(-1), 6),
      ema21: round(ema21.at(-1), 6),
      ema50: round(ema50.at(-1), 6),
      ema100: round(ema100.at(-1), 6),
      rsi14: round(rsiNow, 2),
      macd: round(macdLineLast, 6),
      macdSignal: round(macdSignal, 6),
      atr14: round(atrNow, 6),
      adx14: round(adx, 2),
      stochastic14: round(stochastic, 2),
      bollingerUpper: round(bands.upper, 6),
      bollingerMiddle: round(bands.middle, 6),
      bollingerLower: round(bands.lower, 6),
      volatilityRatio: round(volatilityRatio, 2),
      trendStrength,
      bullishPoints: round(bullish, 2),
      bearishPoints: round(bearish, 2),
      agreement: round(agreement * 100, 1),
      candleAgeSeconds: Math.max(0, Math.round(latestAge / 1000))
    },
    reasons: reasons.slice(-8)
  };
}

// ======================================================
// SCAN ONE PAIR
// ======================================================

async function scanPair(symbol) {
  const pair = getPair(symbol);

  if (!pair) {
    throw new Error("ไม่รองรับคู่เงินนี้");
  }

  const old = pairsCache.get(pair.symbol);

  try {
    const candles = await fetchCandles(pair.symbol);

    if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
      throw new Error(
        `ข้อมูลไม่เพียงพอ: ได้ ${candles.length} แท่ง ต้องการ ${MIN_CANDLES} แท่ง`
      );
    }

    const latest = candles[candles.length - 1];
    const analysis = analyzeCandles(candles);

    const payload = {
      symbol: pair.symbol,
      name: pair.name,
      timeframe: "1min",
      signal: analysis.signal,
      score: analysis.score,
      confidence: analysis.confidence,
      price: latest.close,
      candleTime: new Date(latest.time).toISOString(),
      updatedAt: new Date().toISOString(),
      dataStatus: "LIVE_REFERENCE",
      source: "Twelve Data - reference market",
      reason: analysis.reason,
      indicators: analysis.indicators,
      reasons: analysis.reasons,
      candleCount: candles.length
    };

    pairsCache.set(pair.symbol, payload);
    lastError = null;

    if (state.symbol === pair.symbol) {
      Object.assign(state, payload);
    }

    broadcast({
      type: "pair_update",
      pair: payload
    });

    return payload;
  } catch (error) {
    lastError = error.message;

    const failed = {
      ...(old || {}),
      symbol: pair.symbol,
      name: pair.name,
      signal: "STANDBY",
      dataStatus: "ERROR",
      reason: error.message,
      updatedAt: new Date().toISOString()
    };

    pairsCache.set(pair.symbol, failed);

    if (state.symbol === pair.symbol) {
      Object.assign(state, failed);
    }

    broadcast({
      type: "pair_update",
      pair: failed
    });

    return failed;
  }
}

// ======================================================
// SCAN ALL PAIRS SEQUENTIALLY
// ======================================================

async function scanAllPairs() {
  if (scanInProgress) {
    return { ok: false, message: "กำลังสแกนอยู่" };
  }

  if (!API_KEY) {
    lastError = "ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY";
    broadcastState();
    return { ok: false, message: lastError };
  }

  scanInProgress = true;
  broadcast({
    type: "scan_status",
    scanning: true
  });

  const results = [];

  try {
    // Sequential requests to avoid sending all requests simultaneously.
    for (const pair of PAIRS) {
      const result = await scanPair(pair.symbol);
      results.push(result);

      // Small delay between API requests.
      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    lastScanAt = new Date().toISOString();

    broadcast({
      type: "scan_complete",
      scanning: false,
      lastScanAt,
      pairs: getPairs()
    });

    return {
      ok: true,
      lastScanAt,
      pairsScanned: results.length,
      results
    };
  } finally {
    scanInProgress = false;

    broadcast({
      type: "scan_status",
      scanning: false
    });

    broadcastState();
  }
}

// ======================================================
// PAIR LIST AND BROADCAST
// ======================================================

function getPairs() {
  return PAIRS.map(pair => pairsCache.get(pair.symbol));
}

function buildPayload() {
  return {
    type: "state",
    ok: true,
    configured: Boolean(API_KEY),
    scanning: scanInProgress,
    activeClients,
    lastScanAt,
    lastError,
    pollIntervalMs: POLL_INTERVAL_MS,
    state: { ...state },
    pairs: getPairs()
  };
}

function sendJSON(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastState() {
  broadcast(buildPayload());
}

// ======================================================
// HTTP API
// ======================================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(API_KEY),
    activeClients,
    scanning: scanInProgress,
    lastScanAt,
    time: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.json(buildPayload());
});

app.get("/api/pairs", (req, res) => {
  res.json({
    ok: true,
    pairs: getPairs()
  });
});

app.get("/api/history", (req, res) => {
  // This endpoint exposes current cached pair states, not a historical
  // database of every candle or a backtest result.
  res.json({
    ok: true,
    lastScanAt,
    pairs: getPairs()
  });
});

app.get("/api/settings", (req, res) => {
  res.json({
    ok: true,
    symbol: state.symbol,
    timeframe: state.timeframe,
    threshold: MIN_SCORE,
    pollIntervalMs: POLL_INTERVAL_MS,
    supportedSymbols: PAIRS.map(pair => pair.symbol)
  });
});

app.post("/api/scan", async (req, res) => {
  try {
    const result = await scanAllPairs();
    res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/select", async (req, res) => {
  const pair = getPair(req.body && req.body.symbol);

  if (!pair) {
    return res.status(400).json({
      ok: false,
      error: "คู่เงินไม่ถูกต้อง"
    });
  }

  state.symbol = pair.symbol;
  const cached = pairsCache.get(pair.symbol);

  Object.assign(state, cached, {
    symbol: pair.symbol,
    timeframe: "1min"
  });

  broadcastState();

  res.json({
    ok: true,
    state: { ...state }
  });
});

// ======================================================
// WEBSOCKET
// ======================================================

wss.on("connection", ws => {
  activeClients++;

  sendJSON(ws, buildPayload());

  ws.on("message", async raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      sendJSON(ws, {
        type: "error",
        error: "รูปแบบข้อความไม่ถูกต้อง"
      });
      return;
    }

    const action = String(
      message.action || message.type || ""
    ).toLowerCase();

    if (action === "get_state" || action === "status") {
      sendJSON(ws, buildPayload());
      return;
    }

    if (action === "set_symbol" || action === "select_pair") {
      const pair = getPair(message.symbol);

      if (!pair) {
        sendJSON(ws, {
          type: "error",
          error: "ไม่รองรับคู่เงินนี้"
        });
        return;
      }

      state.symbol = pair.symbol;
      Object.assign(state, pairsCache.get(pair.symbol), {
        symbol: pair.symbol,
        timeframe: "1min"
      });

      sendJSON(ws, buildPayload());
      return;
    }

    if (
      action === "manual_scan" ||
      action === "scan" ||
      action === "rescan"
    ) {
      const result = await scanAllPairs();
      sendJSON(ws, {
        type: "scan_result",
        ...result
      });
      return;
    }

    sendJSON(ws, {
      type: "error",
      error: "ไม่รู้จักคำสั่งนี้"
    });
  });

  ws.on("close", () => {
    activeClients = Math.max(0, activeClients - 1);
  });

  ws.on("error", () => {
    // A disconnected client should not stop the server.
  });
});

// ======================================================
// PERIODIC SCAN
// ======================================================

function startScheduler() {
  if (scanTimer) clearInterval(scanTimer);

  scanTimer = setInterval(async () => {
    // Avoid consuming API credits when nobody is using the Mini App.
    if (activeClients === 0 || scanInProgress || !API_KEY) return;

    await scanAllPairs();
  }, POLL_INTERVAL_MS);
}

// ======================================================
// START SERVER
// ======================================================

app.use((req, res) => {
  if (req.method !== "GET") {
    return res.status(404).json({
      ok: false,
      error: "ไม่พบ endpoint"
    });
  }

  res.sendFile(
    path.join(__dirname, "public", "index.html"),
    error => {
      if (error && !res.headersSent) {
        res.status(404).send(
          "AI Signal Radar is running. Please check the public/index.html file."
        );
      }
    }
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Signal Radar listening on port ${PORT}`);
  console.log(`Twelve Data API configured: ${Boolean(API_KEY)}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS} ms`);
  console.log("Market: Forex reference feed, Non-OTC");
  console.log("Trading execution: disabled");
  startScheduler();
});

process.on("SIGTERM", () => {
  if (scanTimer) clearInterval(scanTimer);

  server.close(() => {
    process.exit(0);
  });
});
