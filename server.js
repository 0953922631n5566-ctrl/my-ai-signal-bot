
"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: "100kb" }));

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY;

// ดึงข้อมูลทุก 2 นาที เพื่อประหยัดโควตาฟรี
const POLL_INTERVAL_MS = Math.max(
  120000,
  Number(process.env.POLL_INTERVAL_MS || 120000)
);

const STALE_AFTER_MS = 4 * 60 * 1000;
const MIN_CANDLES = 55;
const MAX_HISTORY = 5000;

const ALLOWED_SYMBOLS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP"
];

const state = {
  source: "Twelve Data REST API",
  connected: false,
  loading: false,
  symbol: process.env.DEFAULT_SYMBOL || "EUR/USD",
  interval: "1min",
  threshold: 65,
  candles: [],
  price: null,
  signal: "STANDBY",
  score: 0,
  rsi: null,
  trend: "UNKNOWN",
  reason: "กำลังรอข้อมูลตลาด",
  lastUpdated: null,
  lastCandleTime: null,
  lastError: null,
  lastPollAt: null,
  nextPollAt: null,
  apiCalls: 0,
  signalHistory: []
};

if (!ALLOWED_SYMBOLS.includes(state.symbol)) {
  state.symbol = "EUR/USD";
}

let pollTimer = null;
let pollInProgress = false;

// --------------------------------------------------
// HELPERS
// --------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function isFresh() {
  if (!state.lastUpdated) return false;

  return Date.now() - new Date(state.lastUpdated).getTime()
    <= STALE_AFTER_MS;
}

function publicStatus() {
  return {
    ok: true,
    source: state.source,
    connected: state.connected,
    loading: state.loading,
    symbol: state.symbol,
    interval: state.interval,
    price: state.price,
    signal: isFresh() ? state.signal : "STANDBY",
    score: isFresh() ? state.score : 0,
    rsi: state.rsi,
    trend: state.trend,
    reason: isFresh() ? state.reason : "ข้อมูลเก่าเกินไป กรุณารอข้อมูลรอบใหม่",
    lastUpdated: state.lastUpdated,
    lastCandleTime: state.lastCandleTime,
    lastError: state.lastError,
    lastPollAt: state.lastPollAt,
    nextPollAt: state.nextPollAt,
    stale: !isFresh(),
    apiCalls: state.apiCalls,
    candlesCount: state.candles.length,
    threshold: state.threshold
  };
}

function broadcast(type, data) {
  const message = JSON.stringify({
    type,
    data,
    time: nowIso()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function sendStatus() {
  broadcast("status", publicStatus());
}

// --------------------------------------------------
// TWELVE DATA REST API
// API key is sent in an HTTP header, not in the URL.
// Never log request headers or the API key.
// --------------------------------------------------
async function fetchCandles(symbol) {
  if (!API_KEY) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render"
    );
  }

  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("timezone", "UTC");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `apikey ${API_KEY}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const body = await response.json();

    if (!response.ok) {
      throw new Error(`Twelve Data HTTP ${response.status}`);
    }

    if (body.status === "error" || body.code || !Array.isArray(body.values)) {
      const message = String(
        body.message || "Twelve Data ไม่ส่งข้อมูลแท่งเทียนกลับมา"
      );

      // ไม่ส่งรายละเอียดที่อาจมีข้อมูลลับออกไป
      throw new Error(message.slice(0, 220));
    }

    const candles = body.values
      .map((item) => ({
        datetime: item.datetime,
        timestamp: Date.parse(`${item.datetime.replace(" ", "T")}Z`),
        open: safeNumber(item.open),
        high: safeNumber(item.high),
        low: safeNumber(item.low),
        close: safeNumber(item.close),
        volume: safeNumber(item.volume)
      }))
      .filter((c) =>
        Number.isFinite(c.timestamp) &&
        c.open !== null &&
        c.high !== null &&
        c.low !== null &&
        c.close !== null
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    if (candles.length < 20) {
      throw new Error("ข้อมูลแท่งเทียนที่ได้รับยังไม่เพียงพอ");
    }

    return candles;
  } finally {
    clearTimeout(timeout);
  }
}

// --------------------------------------------------
// TECHNICAL INDICATORS
// --------------------------------------------------
function ema(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const result = [];
  let current = values[0];

  result.push(current);

  for (let i = 1; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    result.push(current);
  }

  return result;
}

function calculateRsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateSignal(candles) {
  const closes = candles.map((c) => c.close);

  if (closes.length < MIN_CANDLES) {
    return {
      signal: "STANDBY",
      score: 0,
      rsi: null,
      trend: "UNKNOWN",
      reason: "แท่งเทียนยังไม่ครบสำหรับการวิเคราะห์"
    };
  }

  const ema6 = ema(closes, 6);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi = calculateRsi(closes, 14);

  if (!ema6.length || !ema21.length || !ema50.length || rsi === null) {
    return {
      signal: "STANDBY",
      score: 0,
      rsi: null,
      trend: "UNKNOWN",
      reason: "คำนวณตัวชี้วัดไม่สำเร็จ"
    };
  }

  const last = closes.length - 1;
  const latest = candles[last];
  const previous = candles[last - 1];

  let bullish = 0;
  let bearish = 0;
  const reasons = [];

  // Trend alignment
  if (ema6[last] > ema21[last]) bullish += 25;
  else if (ema6[last] < ema21[last]) bearish += 25;

  if (ema21[last] > ema50[last]) bullish += 25;
  else if (ema21[last] < ema50[last]) bearish += 25;

  // RSI: neutral zone is intentionally not scored
  if (rsi >= 52 && rsi <= 68) bullish += 20;
  else if (rsi <= 48 && rsi >= 32) bearish += 20;

  // Latest candle momentum
  if (latest.close > latest.open) bullish += 15;
  else if (latest.close < latest.open) bearish += 15;

  // Previous candle confirmation
  if (latest.close > previous.close) bullish += 15;
  else if (latest.close < previous.close) bearish += 15;

  const score = Math.max(bullish, bearish);
  let signal = "STANDBY";

  if (bullish > bearish && bullish >= state.threshold) {
    signal = "CALL";
    reasons.push("แนวโน้มและแรงซื้อเอนเอียงขึ้น");
  } else if (bearish > bullish && bearish >= state.threshold) {
    signal = "PUT";
    reasons.push("แนวโน้มและแรงขายเอนเอียงลง");
  } else {
    reasons.push("คะแนนยังไม่ถึงเกณฑ์ หรือสัญญาณขัดแย้งกัน");
  }

  if (rsi > 70) reasons.push("RSI สูง อาจมีแรงซื้อมากเกินไป");
  if (rsi < 30) reasons.push("RSI ต่ำ อาจมีแรงขายมากเกินไป");

  return {
    signal,
    score,
    rsi: round(rsi, 2),
    trend:
      ema21[last] > ema50[last]
        ? "UP"
        : ema21[last] < ema50[last]
          ? "DOWN"
          : "SIDEWAYS",
    reason: reasons.join(" | ")
  };
}

// --------------------------------------------------
// REFRESH DATA
// --------------------------------------------------
async function refreshData() {
  if (pollInProgress) return;
  pollInProgress = true;

  state.loading = true;
  state.lastPollAt = nowIso();
  sendStatus();

  try {
    const candles = await fetchCandles(state.symbol);

    state.candles = candles.slice(-MAX_HISTORY);
    state.price = candles[candles.length - 1].close;
    state.lastCandleTime = candles[candles.length - 1].datetime;
    state.lastUpdated = nowIso();
    state.connected = true;
    state.lastError = null;
    state.apiCalls += 1;

    const result = calculateSignal(state.candles);

    state.signal = result.signal;
    state.score = result.score;
    state.rsi = result.rsi;
    state.trend = result.trend;
    state.reason = result.reason;

    if (result.signal !== "STANDBY") {
      const lastHistory = state.signalHistory[0];

      // Avoid storing the same signal repeatedly for the same candle
      if (
        !lastHistory ||
        lastHistory.symbol !== state.symbol ||
        lastHistory.candleTime !== state.lastCandleTime ||
        lastHistory.signal !== result.signal
      ) {
        state.signalHistory.unshift({
          symbol: state.symbol,
          candleTime: state.lastCandleTime,
          time: nowIso(),
          price: state.price,
          signal: result.signal,
          score: result.score,
          rsi: result.rsi
        });

        state.signalHistory = state.signalHistory.slice(0, 200);
      }
    }

    broadcast("market", {
      ...publicStatus(),
      candles: state.candles.slice(-120)
    });
  } catch (error) {
    state.connected = false;
    state.signal = "STANDBY";
    state.score = 0;

    // Show a safe, useful error without exposing credentials
    state.lastError = error.name === "AbortError"
      ? "Twelve Data ตอบกลับช้าเกินกำหนด"
      : String(error.message || "ดึงข้อมูลไม่สำเร็จ").slice(0, 220);

    state.reason = state.lastError;
    sendStatus();
  } finally {
    state.loading = false;
    state.nextPollAt = new Date(Date.now() + POLL_INTERVAL_MS).toISOString();
    pollInProgress = false;
    sendStatus();
  }
}

// --------------------------------------------------
// HTTP API — keep compatibility with existing Mini App
// --------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "AI Signal Radar",
    source: state.source,
    configured: Boolean(API_KEY),
    time: nowIso()
  });
});

app.get("/api/status", (req, res) => {
  res.json(publicStatus());
});

app.get("/api/history", (req, res) => {
  res.json({
    ok: true,
    symbol: state.symbol,
    candles: state.candles.slice(-200),
    signals: state.signalHistory.slice(0, 100)
  });
});

app.get("/api/settings", (req, res) => {
  res.json({
    ok: true,
    symbol: state.symbol,
    threshold: state.threshold,
    pollIntervalMs: POLL_INTERVAL_MS,
    allowedSymbols: ALLOWED_SYMBOLS
  });
});

app.post("/api/settings", async (req, res) => {
  const { symbol, threshold } = req.body || {};
  let changed = false;

  if (symbol !== undefined) {
    if (!ALLOWED_SYMBOLS.includes(symbol)) {
      return res.status(400).json({
        ok: false,
        error: "คู่เงินนี้ไม่ได้อยู่ในรายการที่รองรับ"
      });
    }

    if (symbol !== state.symbol) {
      state.symbol = symbol;
      state.connected = false;
      state.lastUpdated = null;
      state.signal = "STANDBY";
      state.score = 0;
      changed = true;
    }
  }

  if (threshold !== undefined) {
    const value = Number(threshold);

    if (!Number.isFinite(value) || value < 40 || value > 90) {
      return res.status(400).json({
        ok: false,
        error: "threshold ต้องอยู่ระหว่าง 40 ถึง 90"
      });
    }

    state.threshold = value;
  }

  if (changed) {
    // Symbol changes cause one extra API request.
    // Avoid repeatedly changing symbols on a free quota.
    await refreshData();
  }

  res.json({
    ok: true,
    settings: {
      symbol: state.symbol,
      threshold: state.threshold
    }
  });
});

// Keep a simple recording endpoint for the existing app.
// This stores the user's result in memory only; it does not place orders.
app.post("/api/record", (req, res) => {
  const { result, symbol, signal, note } = req.body || {};

  const record = {
    time: nowIso(),
    result: String(result || "unknown").slice(0, 30),
    symbol: String(symbol || state.symbol).slice(0, 30),
    signal: String(signal || state.signal).slice(0, 20),
    note: String(note || "").slice(0, 200)
  };

  state.signalHistory.unshift(record);
  state.signalHistory = state.signalHistory.slice(0, 200);

  res.json({ ok: true, record });
});

// Serve the existing Mini App
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------
// WEBSOCKET — the browser connects to this server,
// not directly to Twelve Data. API key stays private.
// --------------------------------------------------
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({
    type: "status",
    data: publicStatus(),
    time: nowIso()
  }));

  socket.send(JSON.stringify({
    type: "market",
    data: {
      ...publicStatus(),
      candles: state.candles.slice(-120)
    },
    time: nowIso()
  }));
});

// --------------------------------------------------
// STARTUP
// --------------------------------------------------
server.listen(PORT, () => {
  console.log(`AI Signal Radar server listening on port ${PORT}`);
  console.log(`Twelve Data API key configured: ${Boolean(API_KEY)}`);

  // First request on startup, then every two minutes by default
  refreshData();

  pollTimer = setInterval(() => {
    refreshData();
  }, POLL_INTERVAL_MS);
});

function shutdown() {
  if (pollTimer) clearInterval(pollTimer);

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
