"use strict";

const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const PAIR = process.env.FOREX_PAIR || "EUR/USD";
const POLL_MS = Math.max(
  60000,
  Number(process.env.POLL_INTERVAL_MS || 60000)
);
const MIN_SCORE = Math.min(
  90,
  Math.max(50, Number(process.env.MIN_SIGNAL_SCORE || 68))
);

const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(PUBLIC_DIR));

let state = {
  pair: PAIR,
  timeframe: "1min",
  source: "Twelve Data",
  direction: "STANDBY",
  score: 0,
  price: null,
  candleTime: null,
  updatedAt: null,
  lastPollAt: null,
  lastSuccessAt: null,
  error: null,
  indicators: {
    ema9: null,
    ema21: null,
    rsi14: null,
    macd: null
  },
  note: "กำลังรอข้อมูลตลาด"
};

let pollInProgress = false;
let lastSuccessfulPollMs = 0;
let nextPollAt = null;

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMacd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  if (fast === null || slow === null) return null;

  return fast - slow;
}

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function calculateSignal(candles) {
  if (!Array.isArray(candles) || candles.length < 35) {
    throw new Error("ข้อมูลแท่งเทียนไม่เพียงพอ ต้องมีอย่างน้อย 35 แท่ง");
  }

  // Twelve Data ส่งแท่งล่าสุดมาก่อน จึงกลับลำดับให้เก่าไปใหม่
  const ordered = [...candles].reverse();

  const closes = ordered.map((c) => Number(c.close));
  const latest = ordered[ordered.length - 1];

  if (
    closes.some((v) => !Number.isFinite(v)) ||
    !Number.isFinite(Number(latest.close))
  ) {
    throw new Error("รูปแบบข้อมูลราคาจากผู้ให้บริการไม่ถูกต้อง");
  }

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  const macd = calculateMacd(closes);

  if ([ema9, ema21, rsi14, macd].some((v) => v === null)) {
    throw new Error("คำนวณอินดิเคเตอร์ไม่สำเร็จ");
  }

  let bull = 0;
  let bear = 0;

  if (ema9 > ema21) bull += 2;
  else if (ema9 < ema21) bear += 2;

  if (Number(latest.close) > ema9) bull += 1;
  else if (Number(latest.close) < ema9) bear += 1;

  if (macd > 0) bull += 1;
  else if (macd < 0) bear += 1;

  if (rsi14 >= 52 && rsi14 <= 68) bull += 1;
  else if (rsi14 <= 48 && rsi14 >= 32) bear += 1;

  const total = bull + bear;
  const dominant = Math.max(bull, bear);
  const score = total === 0 ? 0 : Math.round((dominant / total) * 100);

  let direction = "STANDBY";
  let note = "เงื่อนไขยังไม่ชัดเจน รอประเมินรอบถัดไป";

  if (score >= MIN_SCORE && bull > bear) {
    direction = "CALL";
    note = "แนวโน้มระยะสั้นเอนเอียงขึ้น แต่ไม่รับประกันผล";
  } else if (score >= MIN_SCORE && bear > bull) {
    direction = "PUT";
    note = "แนวโน้มระยะสั้นเอนเอียงลง แต่ไม่รับประกันผล";
  }

  return {
    pair: PAIR,
    timeframe: "1min",
    source: "Twelve Data",
    direction,
    score,
    price: round(Number(latest.close), 6),
    candleTime: latest.datetime || null,
    updatedAt: new Date().toISOString(),
    indicators: {
      ema9: round(ema9, 6),
      ema21: round(ema21, 6),
      rsi14: round(rsi14, 2),
      macd: round(macd, 8)
    },
    note
  };
}

async function fetchCandles() {
  if (!API_KEY) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render Environment"
    );
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", PAIR);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Twelve Data ตอบกลับ HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "error" || data.code || data.message) {
      throw new Error(
        String(data.message || data.code || "ผู้ให้บริการปฏิเสธคำขอ")
      );
    }

    if (!Array.isArray(data.values) || data.values.length === 0) {
      throw new Error("ไม่พบข้อมูลแท่งเทียนจาก Twelve Data");
    }

    return data.values;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("หมดเวลารอข้อมูลจาก Twelve Data");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollMarket() {
  if (pollInProgress) return;

  pollInProgress = true;
  state.lastPollAt = new Date().toISOString();

  try {
    const candles = await fetchCandles();
    const result = calculateSignal(candles);

    state = {
      ...state,
      ...result,
      lastPollAt: state.lastPollAt,
      lastSuccessAt: new Date().toISOString(),
      error: null
    };

    lastSuccessfulPollMs = Date.now();
    console.log(
      `[OK] ${state.pair} ${state.direction} score=${state.score} price=${state.price}`
    );
  } catch (error) {
    state.error = error.message || "ไม่สามารถดึงข้อมูลตลาดได้";
    console.error("[MARKET ERROR]", state.error);
  } finally {
    pollInProgress = false;
    nextPollAt = new Date(Date.now() + POLL_MS).toISOString();
  }
}

app.get("/api/health", (req, res) => {
  const now = Date.now();
  const recentSuccess =
    lastSuccessfulPollMs > 0 &&
    now - lastSuccessfulPollMs <= Math.max(POLL_MS * 3, 180000);

  const ok = Boolean(API_KEY) && recentSuccess && !state.error;

  res.status(200).json({
    ok,
    apiKeyConfigured: Boolean(API_KEY),
    provider: "Twelve Data",
    pair: PAIR,
    timeframe: "1min",
    pollIntervalMs: POLL_MS,
    lastPollAt: state.lastPollAt,
    lastSuccessAt: state.lastSuccessAt,
    nextPollAt,
    error: state.error
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    pair: state.pair,
    timeframe: state.timeframe,
    source: state.source,
    direction: state.direction,
    score: state.score,
    price: state.price,
    candleTime: state.candleTime,
    updatedAt: state.updatedAt,
    lastPollAt: state.lastPollAt,
    lastSuccessAt: state.lastSuccessAt,
    error: state.error,
    indicators: state.indicators,
    note: state.note,
    minSignalScore: MIN_SCORE,
    nextPollAt
  });
});

app.get("/api/radar", (req, res) => {
  res.json({
    updatedAt: state.updatedAt,
    results: [state]
  });
});

app.get("/api/scan", async (req, res) => {
  await pollMarket();

  res.status(state.error ? 503 : 200).json({
    ok: !state.error,
    result: state
  });
});

app.get("/api", (req, res) => {
  res.redirect("/");
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`AI Signal Radar listening on port ${PORT}`);
  console.log(`Pair: ${PAIR} | Poll: ${POLL_MS}ms`);

  await pollMarket();

  setInterval(pollMarket, POLL_MS);
});