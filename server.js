"use strict";

const express = require("express");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.FOREX_PAIR || "EUR/USD";
const POLL_MS = Math.max(60000, Number(process.env.POLL_INTERVAL_MS) || 60000);
const MIN_SCORE = Math.min(90, Math.max(60, Number(process.env.MIN_SIGNAL_SCORE) || 70));
const MAX_DATA_AGE_MS = 90000;
const SIGNAL_DURATION_MS = 40000;
const EMA_PERIODS = [3, 5, 8, 9, 12, 15, 18, 21, 25, 30, 35, 40, 50, 75, 100];

const state = {
  source: "Twelve Data", symbol: SYMBOL, interval: "1min",
  price: null, candleTime: null, fetchedAt: null, fetchedAtMs: 0,
  emaValues: {}, emaSignals: [], marketTrend: "NEUTRAL",
  rsi14: null, macd: null, bullVotes: 0, bearVotes: 0,
  score: 0, candidate: "STANDBY", reason: "กำลังรอข้อมูลตลาด",
  error: null, candles: [], lastPollAt: null, nextPollAt: null
};

let pollInProgress = false;
let pollTimer = null;
let latestOcr = null;
const ocrRateLimits = new Map();

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) current = values[i] * k + current * (1 - k);
  return current;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const result = Array(period - 1).fill(null);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result.push(current);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    result.push(current);
  }
  return result;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateMACD(values) {
  if (!Array.isArray(values) || values.length < 35) return null;
  const fast = ema(values, 12), slow = ema(values, 26);
  return Number.isFinite(fast) && Number.isFinite(slow) ? fast - slow : null;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

async function fetchMarketData() {
  if (!API_KEY) throw new Error("ยังไม่ได้ตั้ง TWELVE_DATA_API_KEY ใน Render Environment Variables");

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error("Twelve Data HTTP " + response.status);

  const json = await response.json();
  if (json.status === "error" || json.code || !Array.isArray(json.values)) {
    throw new Error(json.message || "Twelve Data ไม่ส่งข้อมูลแท่งเทียน");
  }

  const nowMs = Date.now();
  const completedCandles = json.values.slice().reverse().filter(c => {
    const openedAt = Date.parse(String(c.datetime || "").replace(" ", "T") + "Z");
    return Number.isFinite(openedAt) && openedAt + 60000 <= nowMs;
  });

  if (completedCandles.length < 100) {
    throw new Error("ต้องมีแท่งเทียนที่ปิดแล้วอย่างน้อย 100 แท่งเพื่อคำนวณ EMA 100");
  }

  const parsedCandles = completedCandles.map(c => ({
    datetime: c.datetime || null,
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
    volume: c.volume === undefined || c.volume === null || c.volume === "" ? null : Number(c.volume)
  }));
  if (parsedCandles.some(c => [c.open, c.high, c.low, c.close].some(v => !Number.isFinite(v) || v <= 0))) {
    throw new Error("ข้อมูล OHLC ที่ได้รับไม่ถูกต้อง");
  }

  const closes = parsedCandles.map(c => c.close);
  const lastIndex = closes.length - 1;
  const previousIndex = lastIndex - 1;
  const series = {};
  const latestEma = {};

  for (const period of EMA_PERIODS) {
    series[period] = emaSeries(closes, period);
    latestEma[period] = series[period][lastIndex];
  }

  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const price = closes[lastIndex];
  const lastCandle = parsedCandles[lastIndex];
  const previousCandle = parsedCandles[previousIndex];

  // ATR(14): Wilder-style smoothed true range, using completed candles only.
  function calculateATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length <= period) return null;
    const ranges = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], prev = candles[i - 1];
      ranges.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
    }
    let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < ranges.length; i++) value = (value * (period - 1) + ranges[i]) / period;
    return value;
  }

  const atr14 = calculateATR(parsedCandles, 14);
  const volumeValues = parsedCandles.map(c => Number(c.volume));
  const volumeWindow = volumeValues.slice(Math.max(0, lastIndex - 20), lastIndex);
  const volumeAvailable = volumeWindow.length === 20 &&
    [...volumeWindow, volumeValues[lastIndex]].every(v => Number.isFinite(v) && v > 0);
  const averageVolume = volumeWindow.length === 20
    ? volumeWindow.reduce((a, b) => a + b, 0) / volumeWindow.length : null;
  const volumeRatio = volumeAvailable && Number.isFinite(averageVolume) && averageVolume > 0
    ? volumeValues[lastIndex] / averageVolume : null;

  if (!Number.isFinite(rsi) || !Number.isFinite(macd) ||
      !Number.isFinite(atr14) || !Number.isFinite(latestEma[5]) ||
      !Number.isFinite(latestEma[20]) || !Number.isFinite(series[5][previousIndex]) ||
      !Number.isFinite(series[20][previousIndex])) {
    throw new Error("คำนวณ EMA 5/20, RSI 14, ATR 14 จากแท่งปิดไม่สำเร็จ");
  }

  // The strategy is based on a confirmed EMA 5/20 crossover on the latest closed candle.
  const previousEma5 = series[5][previousIndex];
  const previousEma20 = series[20][previousIndex];
  const currentEma5 = latestEma[5];
  const currentEma20 = latestEma[20];
  const crossedUp = previousEma5 <= previousEma20 && currentEma5 > currentEma20;
  const crossedDown = previousEma5 >= previousEma20 && currentEma5 < currentEma20;
  const closeAboveBoth = price > currentEma5 && price > currentEma20;
  const closeBelowBoth = price < currentEma5 && price < currentEma20;

  // A missing/zero volume field is not treated as confirmation.
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1.05;
  // Avoid dead markets: ATR must be at least 0.003% of price.
  const atrConfirmed = atr14 / price >= 0.00003;
  const buyMomentum = rsi > 50;
  const sellMomentum = rsi < 50;

  // Trap detector: previous completed candle has a long rejection wick;
  // current completed candle must break its opposite edge to confirm reversal.
  function candleShape(c) {
    const body = Math.max(Math.abs(c.close - c.open), Number.EPSILON);
    return {
      upperWick: c.high - Math.max(c.open, c.close),
      lowerWick: Math.min(c.open, c.close) - c.low,
      body
    };
  }
  const previousShape = candleShape(previousCandle);
  const bullTrap = previousCandle.close > previousCandle.open &&
    previousShape.upperWick >= previousShape.body * 1.5 &&
    lastCandle.close < previousCandle.low;
  const bearTrap = previousCandle.close < previousCandle.open &&
    previousShape.lowerWick >= previousShape.body * 1.5 &&
    lastCandle.close > previousCandle.high;

  const signals = [];
  let candidate = "STANDBY";
  let reason = "ยังไม่มี EMA 5/20 crossover ที่ผ่านตัวกรองทั้งหมด";
  let score = 0;
  let marketTrend = currentEma5 > currentEma20 ? "UP" :
    currentEma5 < currentEma20 ? "DOWN" : "NEUTRAL";

  const commonFiltersPass = atrConfirmed && volumeConfirmed;
  if (!volumeAvailable) {
    reason = "ไม่มีข้อมูล Volume จากผู้ให้บริการ จึงไม่ยืนยันสัญญาณ";
  } else if (!volumeConfirmed) {
    reason = "Volume ยังไม่ยืนยันแรงซื้อขาย (ต้องไม่น้อยกว่า 1.05 เท่าของค่าเฉลี่ย 20 แท่ง)";
  } else if (!atrConfirmed) {
    reason = "ATR ต่ำเกินไป ตลาดนิ่ง จึงงดเข้าออเดอร์";
  } else if (bullTrap && sellMomentum) {
    candidate = "PUT";
    score = 85;
    reason = "ตรวจพบ Bull Trap: ไส้บนยาวและแท่งปิดถัดมาหลุด Low ของแท่งกับดัก";
  } else if (bearTrap && buyMomentum) {
    candidate = "CALL";
    score = 85;
    reason = "ตรวจพบ Bear Trap: ไส้ล่างยาวและแท่งปิดถัดมาทะลุ High ของแท่งกับดัก";
  } else if (commonFiltersPass && crossedUp && closeAboveBoth && buyMomentum) {
    candidate = "CALL";
    score = 80;
    reason = "EMA 5 ตัดขึ้น EMA 20, แท่งปิดเหนือทั้งสองเส้น, RSI > 50, ATR และ Volume ผ่าน";
  } else if (commonFiltersPass && crossedDown && closeBelowBoth && sellMomentum) {
    candidate = "PUT";
    score = 80;
    reason = "EMA 5 ตัดลง EMA 20, แท่งปิดต่ำกว่าทั้งสองเส้น, RSI < 50, ATR และ Volume ผ่าน";
  }

  if (candidate !== "STANDBY") {
    signals.push({
      id: String(lastCandle.datetime) + ":EMA5-20:" + candidate,
      ema: "5/20", direction: candidate, score,
      candleTime: lastCandle.datetime, reason
    });
  }

  let bullVotes = 0, bearVotes = 0;
  for (const period of EMA_PERIODS) {
    if (price > latestEma[period]) bullVotes++;
    else if (price < latestEma[period]) bearVotes++;
  }

  const now = Date.now();
  const emaValues = {};
  for (const period of EMA_PERIODS) emaValues[period] = round(latestEma[period]);

  const firstChartIndex = Math.max(0, parsedCandles.length - 80);
  const chartCandles = parsedCandles.slice(firstChartIndex).map((c, offset) => {
    const index = firstChartIndex + offset;
    const emaAtCandle = {};
    for (const period of EMA_PERIODS) emaAtCandle[period] = round(series[period][index]);
    return { ...c, emas: emaAtCandle };
  });

  Object.assign(state, {
    price: round(price), candleTime: lastCandle.datetime,
    fetchedAt: new Date(now).toISOString(), fetchedAtMs: now,
    emaValues, emaSignals: signals, marketTrend,
    rsi14: round(rsi, 2), macd: round(macd, 8),
    atr14: round(atr14, 8), volumeRatio: round(volumeRatio, 3),
    bullVotes, bearVotes, score,
    candidate, reason,
    candles: chartCandles, error: null,
    lastPollAt: new Date(now).toISOString(),
    nextPollAt: new Date(now + POLL_MS).toISOString()
  });

  console.log("[MARKET] " + SYMBOL + " price=" + state.price +
    " trend=" + marketTrend + " atr14=" + state.atr14 +
    " volumeRatio=" + state.volumeRatio + " primary=" + state.candidate);

}

async function pollMarket() {
  if (pollInProgress) return false;
  pollInProgress = true;
  try {
    await fetchMarketData();
    return true;
  } catch (error) {
    state.error = error.message || "ดึงข้อมูลตลาดไม่สำเร็จ";
    state.candidate = "STANDBY";
    state.score = 0;
    state.emaSignals = [];
    state.reason = "ข้อมูลไม่พร้อม จึงไม่สร้างสัญญาณ";
    state.nextPollAt = new Date(Date.now() + POLL_MS).toISOString();
    console.error("[MARKET ERROR]", state.error);
    return false;
  } finally {
    pollInProgress = false;
  }
}

function publicState() {
  const age = state.fetchedAtMs ? Date.now() - state.fetchedAtMs : Infinity;
  const fresh = age <= MAX_DATA_AGE_MS && !state.error;
  return {
    source: state.source, symbol: state.symbol, interval: state.interval,
    price: state.price, candleTime: state.candleTime, fetchedAt: state.fetchedAt,
    dataAgeMs: Number.isFinite(age) ? age : null, dataFresh: fresh,
    emaPeriods: EMA_PERIODS, emaValues: state.emaValues,
    emaSignals: fresh ? state.emaSignals : [],
    marketTrend: fresh ? state.marketTrend : "NEUTRAL",
    candles: fresh ? state.candles : [],
    rsi14: state.rsi14, macd: state.macd,
    atr14: state.atr14, volumeRatio: state.volumeRatio,
    bullVotes: state.bullVotes, bearVotes: state.bearVotes,
    score: fresh ? state.score : 0,
    candidate: fresh ? state.candidate : "STANDBY",
    reason: fresh ? state.reason : "ข้อมูลตลาดเก่าหรือยังไม่พร้อม",
    error: state.error, lastPollAt: state.lastPollAt, nextPollAt: state.nextPollAt,
    serverTime: Date.now(), signalDurationMs: SIGNAL_DURATION_MS, minScore: MIN_SCORE
  };
}

app.get("/api/health", (req, res) => {
  const data = publicState();
  res.set("Cache-Control", "no-store");
  res.json({
    ok: Boolean(API_KEY) && data.dataFresh,
    apiKeyConfigured: Boolean(API_KEY), dataFresh: data.dataFresh,
    source: data.source, symbol: data.symbol, serverTime: Date.now(),
    error: data.error || (!API_KEY ? "ยังไม่ได้ตั้ง API Key" : null)
  });
});

app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(publicState());
});

app.get("/api/radar", (req, res) => {
  const data = publicState();
  res.set("Cache-Control", "no-store");
  res.json({
    source: data.source, dataFresh: data.dataFresh, marketTrend: data.marketTrend,
    pairs: [{
      symbol: data.symbol, price: data.price, candidate: data.candidate,
      score: data.score, rsi14: data.rsi14, reason: data.reason,
      emaSignals: data.emaSignals
    }]
  });
});


// OCR companion feed: receives extracted fields only, never screenshots or raw screen text.
app.post("/api/ocr", (req, res) => {
  res.set("Cache-Control", "no-store");
  const now = Date.now();
  const client = String(req.ip || "unknown");
  const last = ocrRateLimits.get(client) || 0;
  if (now - last < 900) return res.status(429).json({ ok: false, error: "ส่งข้อมูลถี่เกินไป" });
  ocrRateLimits.set(client, now);

  const body = req.body || {};
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: "รูปแบบคู่เงินไม่ถูกต้อง" });
  }

  const candidates = Array.isArray(body.priceCandidates)
    ? body.priceCandidates.map(Number).filter(v => Number.isFinite(v) && v > 0 && v < 100000).slice(0, 8)
    : [];
  const countdown = typeof body.countdown === "string" && /^\d{1,2}:\d{2}$/.test(body.countdown)
    ? body.countdown : null;
  const capturedAt = typeof body.capturedAt === "number" && Number.isFinite(body.capturedAt)
    ? body.capturedAt : now;

  latestOcr = {
    source: "Android MediaProjection + ML Kit OCR",
    symbol,
    marketType: body.marketType === "OTC" ? "OTC" : "DIGITAL_OR_UNKNOWN",
    priceCandidates: [...new Set(candidates)],
    countdown,
    capturedAt,
    receivedAt: new Date(now).toISOString(),
    receivedAtMs: now,
    dataFresh: now - capturedAt >= -5000 && now - capturedAt <= 15000
  };
  res.status(202).json({ ok: true, received: true, dataFresh: latestOcr.dataFresh });
});

app.get("/api/ocr/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!latestOcr) return res.json({ connected: false, data: null });
  const ageMs = Date.now() - latestOcr.receivedAtMs;
  res.json({
    connected: ageMs <= 15000,
    ageMs,
    data: {
      source: latestOcr.source,
      symbol: latestOcr.symbol,
      marketType: latestOcr.marketType,
      priceCandidates: latestOcr.priceCandidates,
      countdown: latestOcr.countdown,
      capturedAt: latestOcr.capturedAt,
      receivedAt: latestOcr.receivedAt,
      dataFresh: ageMs <= 15000 && latestOcr.dataFresh
    }
  });
});

async function handleScan(req, res) {
  res.set("Cache-Control", "no-store");
  const age = state.fetchedAtMs ? Date.now() - state.fetchedAtMs : Infinity;
  if ((!state.fetchedAtMs || age >= POLL_MS) && !pollInProgress) await pollMarket();
  const data = publicState();
  res.status(data.error && !data.fetchedAt ? 503 : 200).json({ ok: !data.error && data.dataFresh, ...data });
}

app.get("/api/scan", handleScan);
app.post("/api/scan", handleScan);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, async () => {
  console.log("AI Signal Radar running on port " + PORT);
  await pollMarket();
  pollTimer = setInterval(pollMarket, POLL_MS);
});

process.on("SIGTERM", () => {
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});
