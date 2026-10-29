
"use strict";

const express = require("express");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1h"
}));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.FOREX_PAIR || "EUR/USD";
const POLL_MS = Math.max(60000, Number(process.env.POLL_INTERVAL_MS) || 60000);
const MIN_SCORE = Math.min(90, Math.max(60, Number(process.env.MIN_SIGNAL_SCORE) || 70));
const MAX_DATA_AGE_MS = 90000;
const SIGNAL_DURATION_MS = 40000;

const state = {
  source: "Twelve Data",
  symbol: SYMBOL,
  interval: "1min",
  price: null,
  candleTime: null,
  fetchedAt: null,
  fetchedAtMs: 0,
  ema9: null,
  ema21: null,
  ema50: null,
  rsi14: null,
  macd: null,
  bullVotes: 0,
  bearVotes: 0,
  score: 0,
  candidate: "STANDBY",
  reason: "กำลังรอข้อมูลตลาด",
  error: null,
  lastPollAt: null,
  nextPollAt: null
};

let pollInProgress = false;
let pollTimer = null;

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;

  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (!Array.isArray(values) || values.length < 35) return null;

  const fast = ema(values, 12);
  const slow = ema(values, 26);

  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null;
  return fast - slow;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

async function fetchMarketData() {
  if (!API_KEY) {
    throw new Error("ยังไม่ได้ตั้ง TWELVE_DATA_API_KEY ใน Render Environment Variables");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.status === "error" || json.code || !Array.isArray(json.values)) {
    throw new Error(json.message || "Twelve Data ไม่ส่งข้อมูลแท่งเทียน");
  }

  if (json.values.length < 50) {
    throw new Error("ข้อมูลแท่งเทียนไม่เพียงพอสำหรับคำนวณตัวชี้วัด");
  }

  const candles = json.values.slice().reverse();
  const closes = candles.map(c => Number(c.close));

  if (closes.some(v => !Number.isFinite(v) || v <= 0)) {
    throw new Error("ข้อมูลราคาที่ได้รับไม่ถูกต้อง");
  }

  const last = candles[candles.length - 1];
  const price = Number(last.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);

  if ([price, e9, e21, e50, rsi, macd].some(v => !Number.isFinite(v))) {
    throw new Error("คำนวณตัวชี้วัดไม่สำเร็จ");
  }

  let bull = 0;
  let bear = 0;

  if (e9 > e21) bull++;
  else if (e9 < e21) bear++;

  if (e21 > e50) bull++;
  else if (e21 < e50) bear++;

  if (price > e9) bull++;
  else if (price < e9) bear++;

  if (rsi >= 52 && rsi < 70) bull++;
  else if (rsi <= 48 && rsi > 30) bear++;

  if (macd > 0) bull++;
  else if (macd < 0) bear++;

  const score = Math.round(Math.max(bull, bear) / 5 * 100);
  let candidate = "STANDBY";
  let reason = "สัญญาณยังไม่ชัดเจน";

  if (score >= MIN_SCORE && bull > bear) {
    candidate = "CALL";
    reason = "แนวโน้มขาขึ้นผ่านเกณฑ์ทางเทคนิค";
  } else if (score >= MIN_SCORE && bear > bull) {
    candidate = "PUT";
    reason = "แนวโน้มขาลงผ่านเกณฑ์ทางเทคนิค";
  }

  const now = Date.now();

  Object.assign(state, {
    price: round(price),
    candleTime: last.datetime || null,
    fetchedAt: new Date(now).toISOString(),
    fetchedAtMs: now,
    ema9: round(e9),
    ema21: round(e21),
    ema50: round(e50),
    rsi14: round(rsi, 2),
    macd: round(macd, 8),
    bullVotes: bull,
    bearVotes: bear,
    score,
    candidate,
    reason,
    error: null,
    lastPollAt: new Date(now).toISOString(),
    nextPollAt: new Date(now + POLL_MS).toISOString()
  });

  console.log(
    `[MARKET] ${SYMBOL} price=${state.price} signal=${candidate} score=${score}`
  );
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
    source: state.source,
    symbol: state.symbol,
    interval: state.interval,
    price: state.price,
    candleTime: state.candleTime,
    fetchedAt: state.fetchedAt,
    dataAgeMs: Number.isFinite(age) ? age : null,
    dataFresh: fresh,
    ema9: state.ema9,
    ema21: state.ema21,
    ema50: state.ema50,
    rsi14: state.rsi14,
    macd: state.macd,
    bullVotes: state.bullVotes,
    bearVotes: state.bearVotes,
    score: fresh ? state.score : 0,
    candidate: fresh ? state.candidate : "STANDBY",
    reason: fresh ? state.reason : "ข้อมูลตลาดเก่าหรือยังไม่พร้อม",
    error: state.error,
    lastPollAt: state.lastPollAt,
    nextPollAt: state.nextPollAt,
    serverTime: Date.now(),
    signalDurationMs: SIGNAL_DURATION_MS,
    minScore: MIN_SCORE
  };
}

app.get("/api/health", (req, res) => {
  const data = publicState();

  res.set("Cache-Control", "no-store");
  res.json({
    ok: Boolean(API_KEY) && data.dataFresh,
    apiKeyConfigured: Boolean(API_KEY),
    dataFresh: data.dataFresh,
    source: data.source,
    symbol: data.symbol,
    serverTime: Date.now(),
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
    source: data.source,
    dataFresh: data.dataFresh,
    pairs: [{
      symbol: data.symbol,
      price: data.price,
      candidate: data.candidate,
      score: data.score,
      rsi14: data.rsi14,
      reason: data.reason
    }]
  });
});

async function handleScan(req, res) {
  res.set("Cache-Control", "no-store");

  const age = state.fetchedAtMs
    ? Date.now() - state.fetchedAtMs
    : Infinity;

  // ใช้ข้อมูลเดิมหากยังไม่ถึงรอบ เพื่อไม่ใช้โควตา API ฟรีเกินจำเป็น
  if ((!state.fetchedAtMs || age >= POLL_MS) && !pollInProgress) {
    await pollMarket();
  }

  const data = publicState();

  res.status(data.error && !data.fetchedAt ? 503 : 200).json({
    ok: !data.error && data.dataFresh,
    ...data
  });
}

app.get("/api/scan", handleScan);
app.post("/api/scan", handleScan);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// รองรับ Express 4 และ Express 5
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, async () => {
  console.log(`AI Signal Radar running on port ${PORT}`);
  await pollMarket();
  pollTimer = setInterval(pollMarket, POLL_MS);
});

process.on("SIGTERM", () => {
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});
