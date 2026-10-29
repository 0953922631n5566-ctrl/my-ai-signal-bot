
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.FOREX_PAIR || "EUR/USD";

const POLL_MS = Math.max(
  60000,
  Number(process.env.POLL_INTERVAL_MS) || 60000
);

const MIN_SCORE = Math.min(
  90,
  Math.max(60, Number(process.env.MIN_SIGNAL_SCORE) || 70)
);

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
  nextPollAt: null,
  serverTime: Date.now()
};

let pollInProgress = false;
let pollTimer = null;

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);
  let result =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

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

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (!Array.isArray(values) || values.length < 35) {
    return null;
  }

  const kFast = 2 / 13;
  const kSlow = 2 / 27;

  let eFast =
    values.slice(0, 12).reduce((a, b) => a + b, 0) / 12;

  let eSlow =
    values.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

  for (let i = 12; i < values.length; i++) {
    eFast = values[i] * kFast + eFast * (1 - kFast);
  }

  for (let i = 26; i < values.length; i++) {
    eSlow = values[i] * kSlow + eSlow * (1 - kSlow);
  }

  return eFast - eSlow;
}

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

async function fetchMarketData() {
  if (!API_KEY) {
    throw new Error("ยังไม่ได้ตั้ง TWELVE_DATA_API_KEY ใน Render");
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const json = await response.json();

  if (
    json.status === "error" ||
    json.code ||
    !Array.isArray(json.values)
  ) {
    throw new Error(
      json.message || "Twelve Data ไม่ส่งข้อมูลแท่งเทียน"
    );
  }

  if (json.values.length < 50) {
    throw new Error("ข้อมูลแท่งเทียนไม่เพียงพอ");
  }

  const candles = json.values.slice().reverse();
  const closes = candles.map(c => Number(c.close));

  if (closes.some(v => !Number.isFinite(v))) {
    throw new Error("พบข้อมูลราคาที่ไม่ถูกต้อง");
  }

  const last = candles[candles.length - 1];
  const price = Number(last.close);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);

  if (
    [price, ema9, ema21, ema50, rsi14, macd]
      .some(v => v === null || !Number.isFinite(v))
  ) {
    throw new Error("คำนวณตัวชี้วัดไม่สำเร็จ");
  }

  let bull = 0;
  let bear = 0;

  if (ema9 > ema21) bull++;
  else if (ema9 < ema21) bear++;

  if (ema21 > ema50) bull++;
  else if (ema21 < ema50) bear++;

  if (price > ema9) bull++;
  else if (price < ema9) bear++;

  if (rsi14 >= 52 && rsi14 < 70) bull++;
  else if (rsi14 <= 48 && rsi14 > 30) bear++;

  if (macd > 0) bull++;
  else if (macd < 0) bear++;

  const score = Math.round((Math.max(bull, bear) / 5) * 100);

  let candidate = "STANDBY";
  let reason = "สัญญาณยังไม่ชัดเจน";

  if (score >= MIN_SCORE && bull > bear) {
    candidate = "CALL";
    reason = "แนวโน้มขาขึ้นผ่านเกณฑ์";
  } else if (score >= MIN_SCORE && bear > bull) {
    candidate = "PUT";
    reason = "แนวโน้มขาลงผ่านเกณฑ์";
  }

  state.price = round(price, 6);
  state.candleTime = last.datetime || null;
  state.fetchedAt = new Date().toISOString();
  state.fetchedAtMs = Date.now();

  state.ema9 = round(ema9, 6);
  state.ema21 = round(ema21, 6);
  state.ema50 = round(ema50, 6);
  state.rsi14 = round(rsi14, 2);
  state.macd = round(macd, 8);

  state.bullVotes = bull;
  state.bearVotes = bear;
  state.score = score;
  state.candidate = candidate;
  state.reason = reason;
  state.error = null;
  state.lastPollAt = state.fetchedAt;
  state.nextPollAt = new Date(Date.now() + POLL_MS).toISOString();

  console.log(
    `[MARKET] ${SYMBOL} price=${state.price} candidate=${candidate} score=${score}`
  );
}

async function pollMarket() {
  if (pollInProgress) return;

  pollInProgress = true;

  try {
    await fetchMarketData();
  } catch (error) {
    state.error = error.message || "ดึงข้อมูลตลาดไม่สำเร็จ";
    state.candidate = "STANDBY";
    state.score = 0;
    state.reason = "ข้อมูลไม่พร้อม ห้ามสร้างสัญญาณเข้าออเดอร์";
    state.nextPollAt = new Date(Date.now() + POLL_MS).toISOString();

    console.error("[MARKET ERROR]", state.error);
  } finally {
    state.serverTime = Date.now();
    pollInProgress = false;
  }
}

function publicState() {
  const now = Date.now();
  const age = state.fetchedAtMs
    ? now - state.fetchedAtMs
    : Infinity;

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
    reason: fresh
      ? state.reason
      : "ข้อมูลตลาดเก่าหรือไม่พร้อม",
    error: state.error,
    lastPollAt: state.lastPollAt,
    nextPollAt: state.nextPollAt,
    serverTime: now,
    signalDurationMs: SIGNAL_DURATION_MS,
    minScore: MIN_SCORE
  };
}

app.get("/api/health", (req, res) => {
  const data = publicState();

  res.json({
    ok: Boolean(API_KEY) && data.dataFresh,
    apiKeyConfigured: Boolean(API_KEY),
    dataFresh: data.dataFresh,
    source: data.source,
    symbol: data.symbol,
    serverTime: Date.now(),
    error:
      data.error ||
      (!API_KEY ? "ยังไม่ได้ตั้ง API Key" : null)
  });
});

app.get("/api/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(publicState());
});

app.get("/api/radar", (req, res) => {
  const data = publicState();

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

app.post("/api/scan", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...publicState() });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ใช้ RegExp route เพื่อรองรับ Express 4 และ Express 5
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
