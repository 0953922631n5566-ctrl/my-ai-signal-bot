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
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close)
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
  if (!Number.isFinite(rsi) || !Number.isFinite(macd) ||
      EMA_PERIODS.some(period => !Number.isFinite(latestEma[period]))) {
    throw new Error("คำนวณ EMA/RSI/MACD จากแท่งปิดไม่สำเร็จ");
  }

  // Regime filter: EMA50/100 alignment and slope over three closed candles.
  const slopeIndex = Math.max(0, lastIndex - 3);
  const ema50Up = latestEma[50] > series[50][slopeIndex];
  const ema100Up = latestEma[100] >= series[100][slopeIndex];
  const ema50Down = latestEma[50] < series[50][slopeIndex];
  const ema100Down = latestEma[100] <= series[100][slopeIndex];

  let marketTrend = "NEUTRAL";
  if (latestEma[50] > latestEma[100] && ema50Up && ema100Up && price > latestEma[50]) {
    marketTrend = "UP";
  } else if (latestEma[50] < latestEma[100] && ema50Down && ema100Down && price < latestEma[50]) {
    marketTrend = "DOWN";
  }

  // Each EMA checks its own closed-candle crossover; trend filter is not a 15-line consensus.
  const previousClose = closes[previousIndex];
  const latestClose = closes[lastIndex];
  const lastCandle = parsedCandles[lastIndex];
  const signals = [];

  for (const period of EMA_PERIODS) {
    const previousEma = series[period][previousIndex];
    const currentEma = series[period][lastIndex];
    if (!Number.isFinite(previousEma) || !Number.isFinite(currentEma)) continue;

    const crossedUp = previousClose <= previousEma && latestClose > currentEma;
    const crossedDown = previousClose >= previousEma && latestClose < currentEma;

    if (crossedUp && marketTrend === "UP") {
      let score = 70;
      if (rsi >= 50 && rsi <= 80) score += 5;
      if (macd > 0) score += 5;
      if (lastCandle.close > lastCandle.open) score += 5;
      signals.push({
        id: String(lastCandle.datetime) + ":EMA" + period + ":CALL",
        ema: period, direction: "CALL", score: Math.min(95, score),
        candleTime: lastCandle.datetime,
        reason: "แท่งปิดตัดขึ้น EMA " + period + " และแนวโน้มหลักเป็นขาขึ้น"
      });
    } else if (crossedDown && marketTrend === "DOWN") {
      let score = 70;
      if (rsi >= 20 && rsi <= 50) score += 5;
      if (macd < 0) score += 5;
      if (lastCandle.close < lastCandle.open) score += 5;
      signals.push({
        id: String(lastCandle.datetime) + ":EMA" + period + ":PUT",
        ema: period, direction: "PUT", score: Math.min(95, score),
        candleTime: lastCandle.datetime,
        reason: "แท่งปิดตัดลง EMA " + period + " และแนวโน้มหลักเป็นขาลง"
      });
    }
  }

  signals.sort((a, b) => b.score - a.score || a.ema - b.ema);
  const primary = signals[0] || null;
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
    bullVotes, bearVotes, score: primary ? primary.score : 0,
    candidate: primary ? primary.direction : "STANDBY",
    reason: primary ? primary.reason : "ไม่มีแท่งปิดตัด EMA ที่ตรงกับแนวโน้มหลัก (" + marketTrend + ")",
    candles: chartCandles, error: null,
    lastPollAt: new Date(now).toISOString(),
    nextPollAt: new Date(now + POLL_MS).toISOString()
  });

  console.log("[MARKET] " + SYMBOL + " price=" + state.price +
    " trend=" + marketTrend + " emaSignals=" + signals.length + " primary=" + state.candidate);
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
