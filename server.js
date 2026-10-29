
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");

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
const SCREEN_INGEST_TOKEN = process.env.SCREEN_INGEST_TOKEN || "";
const SCREEN_TICK_MAX_AGE_MS = 15000;
let latestScreenTick = null;
let lastScreenIngestAt = 0;
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
  url.searchParams.set("outputsize", "120");
  // Forex candle timestamps are requested in UTC so closed-bar filtering is unambiguous.
  url.searchParams.set("timezone", "UTC");
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

  // Twelve Data labels each candle by its opening time. Use UTC and exclude
  // any 1-minute bar that has not finished yet; all indicators/signals use closed bars.
  const candles = json.values.slice().reverse();
  const nowMs = Date.now();
  const completedCandles = candles.filter(c => {
    const openedAt = Date.parse(String(c.datetime || "").replace(" ", "T") + "Z");
    return Number.isFinite(openedAt) && openedAt + 60_000 <= nowMs;
  });

  if (completedCandles.length < 50) {
    throw new Error("ข้อมูลแท่งเทียนที่ปิดแล้วไม่เพียงพอสำหรับคำนวณตัวชี้วัด");
  }

  const closes = completedCandles.map(c => Number(c.close));
  if (closes.some(v => !Number.isFinite(v) || v <= 0)) {
    throw new Error("ข้อมูลราคาปิดที่ได้รับไม่ถูกต้อง");
  }

  // EMA values aligned to each candle index; seed with the first-period SMA.
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

  const ema9Values = emaSeries(closes, 9);
  const ema21Values = emaSeries(closes, 21);
  const ema50Values = emaSeries(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const lastIndex = completedCandles.length - 1;
  const price = closes[lastIndex];
  const e9 = ema9Values[lastIndex];
  const e21 = ema21Values[lastIndex];
  const e50 = ema50Values[lastIndex];

  if ([price, e9, e21, e50, rsi, macd].some(v => !Number.isFinite(v))) {
    throw new Error("คำนวณตัวชี้วัดจากแท่งที่ปิดแล้วไม่สำเร็จ");
  }

  // Compare EMA 9/21/50 across the last THREE CLOSED candles.
  // This recognizes an established trend; a fresh EMA crossover is not required.
  const last3 = completedCandles.slice(-3).map((c, offset) => {
    const i = lastIndex - 2 + offset;
    return {
      candle: c,
      close: closes[i],
      ema9: ema9Values[i],
      ema21: ema21Values[i],
      ema50: ema50Values[i]
    };
  });

  if (last3.length !== 3 || last3.some(x =>
    [x.close, x.ema9, x.ema21, x.ema50].some(v => !Number.isFinite(v))
  )) {
    throw new Error("ต้องมีค่า EMA ครบ 3 แท่งปิดล่าสุด");
  }

  const stackUpCount = last3.filter(x => x.ema9 > x.ema21 && x.ema21 > x.ema50).length;
  const stackDownCount = last3.filter(x => x.ema9 < x.ema21 && x.ema21 < x.ema50).length;
  const oldest = last3[0];
  const middle = last3[1];
  const latest = last3[2];
  const ema9Rising = latest.ema9 > oldest.ema9;
  const ema21Rising = latest.ema21 > oldest.ema21;
  const ema50Rising = latest.ema50 >= oldest.ema50;
  const ema9Falling = latest.ema9 < oldest.ema9;
  const ema21Falling = latest.ema21 < oldest.ema21;
  const ema50Falling = latest.ema50 <= oldest.ema50;

  const lastCandle = completedCandles[lastIndex];
  const previousCandle = completedCandles[lastIndex - 1];
  const lastOpen = Number(lastCandle.open);
  const lastHigh = Number(lastCandle.high);
  const lastLow = Number(lastCandle.low);
  const lastClose = Number(lastCandle.close);
  const lastCandleBullish = lastClose > lastOpen || lastClose > Number(previousCandle.close);
  const lastCandleBearish = lastClose < lastOpen || lastClose < Number(previousCandle.close);

  // Keep the existing RSI/MACD confirmation, but do not treat a strong RSI
  // alone as a reversal and do not require a new EMA crossover.
  const callIndicators = price > e21 && rsi >= 50 && rsi <= 80 && macd > 0;
  const putIndicators = price < e21 && rsi >= 20 && rsi <= 50 && macd < 0;

  const upTrend = stackUpCount >= 2 && latest.ema9 > latest.ema21 &&
    latest.ema21 > latest.ema50 && ema9Rising && ema21Rising &&
    ema50Rising && price > e21 && lastCandleBullish;
  const downTrend = stackDownCount >= 2 && latest.ema9 < latest.ema21 &&
    latest.ema21 < latest.ema50 && ema9Falling && ema21Falling &&
    ema50Falling && price < e21 && lastCandleBearish;

  let bull = 0;
  let bear = 0;
  if (e9 > e21) bull++; else if (e9 < e21) bear++;
  if (e21 > e50) bull++; else if (e21 < e50) bear++;
  if (price > e9) bull++; else if (price < e9) bear++;
  if (rsi >= 50 && rsi <= 80) bull++; else if (rsi >= 20 && rsi < 50) bear++;
  if (macd > 0) bull++; else if (macd < 0) bear++;

  // Use recent CLOSED candles only to estimate ordinary candle range.
  const recent7 = completedCandles.slice(-7).map(c => ({
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close)
  }));
  const valid7 = recent7.length === 7 && recent7.every(c =>
    [c.open, c.high, c.low, c.close].every(Number.isFinite)
  );
  const avgCandleRange = valid7
    ? recent7.reduce((sum, c) => sum + Math.max(0, c.high - c.low), 0) / recent7.length
    : 0;
  const emaGap = Math.abs(price - e9);
  const overextended = avgCandleRange > 0 && emaGap > avgCandleRange * 1.8;

  const score = Math.round(Math.max(bull, bear) / 5 * 100);
  let candidate = "STANDBY";
  let reason = "รอแนวโน้ม EMA ยืนยันจากแท่งปิด 3 แท่ง";

  if (upTrend && callIndicators && !overextended) {
    candidate = "CALL";
    reason = "ตามน้ำขาขึ้น: EMA 9/21/50 เรียงตัวและความชันสนับสนุนใน 3 แท่งปิดล่าสุด พร้อมราคา/RSI/MACD ยืนยัน โดยไม่ต้องรอเส้นตัดกันใหม่";
  } else if (downTrend && putIndicators && !overextended) {
    candidate = "PUT";
    reason = "ตามน้ำขาลง: EMA 9/21/50 เรียงตัวและความชันสนับสนุนใน 3 แท่งปิดล่าสุด พร้อมราคา/RSI/MACD ยืนยัน โดยไม่ต้องรอเส้นตัดกันใหม่";
  } else if (overextended && (upTrend || downTrend)) {
    reason = "STANDBY: แนวโน้มยังไปทางเดิม แต่ราคาห่าง EMA9 มากเกินไป รอจังหวะย่อ";
  } else {
    reason = "STANDBY: EMA 3 แท่งล่าสุดหรือแท่งปิดล่าสุดยังไม่ยืนยันแนวโน้มเดียวกัน";
  }

  const now = Date.now();

  Object.assign(state, {
    price: round(price),
    candleTime: lastCandle.datetime || null,
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


function screenTokenMatches(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match || !SCREEN_INGEST_TOKEN) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(SCREEN_INGEST_TOKEN, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

app.post("/api/screen/ingest", (req, res) => {
  res.set("Cache-Control", "no-store");

  if (SCREEN_INGEST_TOKEN.length < 32) {
    return res.status(503).json({
      ok: false,
      error: "SCREEN_INGEST_TOKEN is not configured (minimum 32 characters)"
    });
  }
  if (!screenTokenMatches(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body || {};
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const price = Number(body.price);
  const capturedAtMs = Date.parse(body.capturedAt);
  const confidence = body.confidence === undefined ? null : Number(body.confidence);
  const now = Date.now();

  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) ||
      !Number.isFinite(price) || price <= 0 || price > 1000000 ||
      !Number.isFinite(capturedAtMs) ||
      capturedAtMs > now + 30000 || now - capturedAtMs > 60000 ||
      (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))) {
    return res.status(400).json({ ok: false, error: "Invalid or stale screen tick" });
  }

  // The Android companion samples roughly once per second. Limit bursts without
  // blocking the intended capture rate; do not log credentials or raw headers.
  if (now - lastScreenIngestAt < 150) {
    return res.status(429).json({ ok: false, error: "Ingest rate limited" });
  }
  lastScreenIngestAt = now;

  latestScreenTick = {
    symbol,
    price,
    capturedAt: new Date(capturedAtMs).toISOString(),
    receivedAt: new Date(now).toISOString(),
    receivedAtMs: now,
    confidence,
    confidenceType: confidence === null ? null : "client heuristic, not calibrated OCR probability"
  };

  return res.status(200).json({ ok: true, received: true, receivedAt: latestScreenTick.receivedAt });
});

app.get("/api/screen/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  const tick = latestScreenTick;
  const ageMs = tick ? Date.now() - tick.receivedAtMs : null;
  const dataFresh = ageMs !== null && ageMs <= SCREEN_TICK_MAX_AGE_MS;
  return res.status(200).json({
    ok: true,
    source: "Android screen OCR",
    status: dataFresh ? "RECEIVING" : "STANDBY",
    dataFresh,
    ageMs,
    tick: dataFresh && tick ? {
      symbol: tick.symbol,
      price: tick.price,
      capturedAt: tick.capturedAt,
      receivedAt: tick.receivedAt,
      confidence: tick.confidence,
      confidenceType: tick.confidenceType
    } : null,
    note: "OCR ticks are screen readings only; they are not yet used as the candle source for CALL/PUT signals."
  });
});

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
