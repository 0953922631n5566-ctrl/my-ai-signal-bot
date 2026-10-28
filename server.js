
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = (process.env.TWELVE_DATA_API_KEY || "").trim();

const PAIRS = (process.env.FOREX_PAIRS || "EUR/USD,GBP/USD,USD/JPY")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);

const MIN_SCORE = clamp(
  Number(process.env.MIN_SIGNAL_SCORE || 68), 40, 95
);
const POLL_MS = clamp(
  Number(process.env.POLL_INTERVAL_MS || 15000), 15000, 120000
);
const MAX_AGE = clamp(
  Number(process.env.MAX_DATA_AGE_SECONDS || 180), 30, 600
);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, digits = 6) {
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

const results = {};
const history = [];
const pairLocks = new Set();

let pairIndex = 0;
let polling = false;
let lastPollAt = null;
let lastError = null;

for (const pair of PAIRS) {
  results[pair] = {
    pair,
    direction: "STANDBY",
    stage: "WAITING",
    score: 0,
    price: null,
    message: "กำลังรอข้อมูลตลาด",
    updatedAt: null,
    lastFetchAt: null,
    signalId: null,
    stale: true,
    dataAgeSeconds: null,
    candleAgeSeconds: null,
    indicators: null,
    reasons: [],
    early: null,
    confirmed: null
  };
}

/* ---------- Indicators ---------- */

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let ema = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0 && gains === 0) return 50;
  if (losses === 0) return 100;
  if (gains === 0) return 0;

  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

/* ---------- Twelve Data REST ---------- */

function parseCandle(item) {
  const raw = String(item.datetime || "").trim();

  // Twelve Data is requested in UTC.
  const normalized = raw.includes("T")
    ? (/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : raw + "Z")
    : raw.replace(" ", "T") + "Z";

  const time = Date.parse(normalized);

  return {
    time,
    datetime: raw,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close)
  };
}

async function fetchCandles(pair) {
  if (!API_KEY) {
    throw new Error("ยังไม่ได้ตั้ง TWELVE_DATA_API_KEY ใน Render");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });

  const body = await response.json();

  if (!response.ok || body.status === "error" ||
      !Array.isArray(body.values)) {
    throw new Error(
      body.message || `Twelve Data HTTP ${response.status}`
    );
  }

  const candles = body.values
    .map(parseCandle)
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);

  if (!candles.length) {
    throw new Error("ไม่ได้รับข้อมูลแท่งเทียน");
  }

  return candles;
}

/* ---------- Signal analysis ---------- */

function analyzeCandles(candles, label = "CLOSED") {
  if (candles.length < 55) {
    return {
      direction: "STANDBY",
      score: 0,
      callScore: 0,
      putScore: 0,
      reasons: ["ต้องการข้อมูลอย่างน้อย 55 แท่ง"],
      indicators: null
    };
  }

  const closes = candles.map(c => c.close);
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const ema6 = calculateEMA(closes, 6);
  const ema12 = calculateEMA(closes, 12);
  const ema21 = calculateEMA(closes, 21);
  const ema26 = calculateEMA(closes, 26);
  const ema50 = calculateEMA(closes, 50);
  const rsi14 = calculateRSI(closes, 14);
  const macd = ema12 !== null && ema26 !== null
    ? ema12 - ema26
    : null;

  let call = 0;
  let put = 0;
  const reasons = [];

  if (ema6 !== null && ema21 !== null) {
    if (ema6 > ema21) {
      call += 24;
      reasons.push("EMA6 above EMA21");
    } else if (ema6 < ema21) {
      put += 24;
      reasons.push("EMA6 below EMA21");
    }
  }

  if (ema21 !== null && ema50 !== null) {
    if (ema21 > ema50) {
      call += 20;
      reasons.push("EMA21 above EMA50");
    } else if (ema21 < ema50) {
      put += 20;
      reasons.push("EMA21 below EMA50");
    }
  }

  if (macd !== null) {
    if (macd > 0) {
      call += 18;
      reasons.push("MACD positive");
    } else if (macd < 0) {
      put += 18;
      reasons.push("MACD negative");
    }
  }

  if (rsi14 !== null) {
    if (rsi14 >= 50 && rsi14 <= 68) {
      call += 14;
      reasons.push("RSI supports upward momentum");
    } else if (rsi14 < 50 && rsi14 >= 32) {
      put += 14;
      reasons.push("RSI supports downward momentum");
    } else {
      reasons.push("RSI extreme or neutral; use caution");
    }
  }

  if (current.close > current.open) {
    call += 12;
    reasons.push(
      label === "EARLY" ? "Forming candle is green" : "Closed candle is green"
    );
  } else if (current.close < current.open) {
    put += 12;
    reasons.push(
      label === "EARLY" ? "Forming candle is red" : "Closed candle is red"
    );
  }

  if (current.close > previous.close) call += 12;
  else if (current.close < previous.close) put += 12;

  const score = Math.max(call, put);
  const margin = Math.abs(call - put);

  let direction = "STANDBY";

  if (score >= MIN_SCORE && margin >= 12) {
    direction = call > put ? "CALL" : "PUT";
  }

  return {
    direction,
    score,
    callScore: call,
    putScore: put,
    reasons,
    indicators: {
      ema6: round(ema6),
      ema21: round(ema21),
      ema50: round(ema50),
      rsi14: round(rsi14, 2),
      macd: round(macd),
      candleTime: current.datetime,
      candleOpen: current.open,
      candleClose: current.close
    }
  };
}

/* ---------- Closed candle / early scan ---------- */

function processCandles(pair, candles, fetchedAt) {
  const now = Date.now();
  const latest = candles[candles.length - 1];

  // Candle age is measured from the candle's closing time.
  const candleCloseTime = latest.time + 60000;
  const candleAgeSeconds = Math.max(
    0, Math.floor((now - candleCloseTime) / 1000)
  );

  // This is the age of our local receipt, NOT the provider's true feed delay.
  const dataAgeSeconds = Math.max(
    0, Math.floor((now - fetchedAt) / 1000)
  );

  const stale = candleAgeSeconds > MAX_AGE;
  const latestAppearsOpen = latest.time <= now && now < candleCloseTime;

  const closedCandles = candles.filter(c => c.time + 60000 <= now);

  const early = !stale && latestAppearsOpen
    ? analyzeCandles(candles, "EARLY")
    : {
        direction: "STANDBY",
        score: 0,
        reasons: [
          stale
            ? "แท่งเทียนเก่าเกินเกณฑ์"
            : "ผู้ให้บริการยังไม่ส่งแท่งที่กำลังก่อตัว"
        ],
        indicators: null
      };

  const confirmed = closedCandles.length >= 55
    ? analyzeCandles(closedCandles, "CLOSED")
    : {
        direction: "STANDBY",
        score: 0,
        reasons: ["กำลังรอแท่งเทียนที่ปิดแล้วให้เพียงพอ"],
        indicators: null
      };

  let chosen;

  if (stale) {
    chosen = {
      direction: "STANDBY",
      stage: "STANDBY",
      score: 0,
      reasons: ["ข้อมูลแท่งเทียนเก่าเกินเกณฑ์"],
      indicators: confirmed.indicators || null
    };
  } else if (latestAppearsOpen && early.direction !== "STANDBY") {
    chosen = { ...early, stage: "EARLY" };
  } else if (confirmed.direction !== "STANDBY") {
    chosen = { ...confirmed, stage: "CONFIRMED" };
  } else {
    chosen = {
      direction: "STANDBY",
      stage: "STANDBY",
      score: Math.max(early.score || 0, confirmed.score || 0),
      reasons: ["ยังไม่มีสัญญาณที่ผ่านเงื่อนไข"],
      indicators: confirmed.indicators || early.indicators || null
    };
  }

  // Only alert once per pair, candle, direction and stage.
  const signalId = chosen.direction === "STANDBY"
    ? null
    : `${pair}|${latest.time}|${chosen.direction}|${chosen.stage}`;

  const result = {
    pair,
    direction: chosen.direction,
    stage: chosen.stage,
    score: chosen.score || 0,
    callScore: chosen.callScore ?? null,
    putScore: chosen.putScore ?? null,
    price: latest.close,
    dataAgeSeconds,
    candleAgeSeconds,
    stale,
    candleTime: latest.datetime,
    latestCandleTime: latest.datetime,
    latestCandleAppearsOpen: latestAppearsOpen,
    candleClosed: chosen.stage === "CONFIRMED",
    updatedAt: new Date().toISOString(),
    lastFetchAt: new Date(fetchedAt).toISOString(),
    signalId,
    source: "Twelve Data REST; not IQ Option feed",
    message: stale
      ? "ข้อมูลแท่งเทียนเก่า กรุณารอข้อมูลใหม่"
      : chosen.stage === "EARLY"
        ? "สัญญาณเบื้องต้น ราคาอาจเปลี่ยนทิศได้"
        : chosen.stage === "CONFIRMED"
          ? "สัญญาณจากแท่งที่ปิดแล้ว"
          : "ยังไม่มีสัญญาณที่ผ่านเงื่อนไข",
    reasons: chosen.reasons || [],
    indicators: chosen.indicators || null,
    early: {
      direction: early.direction,
      score: early.score,
      reasons: early.reasons
    },
    confirmed: {
      direction: confirmed.direction,
      score: confirmed.score,
      reasons: confirmed.reasons
    }
  };

  const previous = results[pair];

  if (signalId && previous.signalId !== signalId) {
    history.unshift({
      id: signalId,
      pair,
      direction: result.direction,
      stage: result.stage,
      score: result.score,
      price: result.price,
      candleTime: result.candleTime,
      createdAt: result.updatedAt
    });
    history.splice(250);
  }

  results[pair] = result;
  return result;
}

/* ---------- Polling with per-pair lock ---------- */

async function pollPair(pair) {
  if (!PAIRS.includes(pair)) {
    throw new Error("Unsupported pair");
  }

  if (pairLocks.has(pair)) {
    return results[pair];
  }

  pairLocks.add(pair);
  const fetchedAt = Date.now();

  try {
    const candles = await fetchCandles(pair);
    processCandles(pair, candles, fetchedAt);
    lastError = null;
  } catch (error) {
    lastError = `${pair}: ${error.message}`;

    results[pair] = {
      ...results[pair],
      direction: "STANDBY",
      stage: "STANDBY",
      signalId: null,
      stale: true,
      message: error.message,
      updatedAt: new Date().toISOString(),
      lastFetchAt: new Date(fetchedAt).toISOString()
    };
  } finally {
    pairLocks.delete(pair);
    lastPollAt = new Date().toISOString();
  }

  return results[pair];
}

async function pollCycle() {
  if (polling || PAIRS.length === 0) return;

  polling = true;

  try {
    const pair = PAIRS[pairIndex % PAIRS.length];
    pairIndex = (pairIndex + 1) % PAIRS.length;
    await pollPair(pair);
  } finally {
    polling = false;
  }
}

/* ---------- API endpoints ---------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY),
    pairs: PAIRS,
    minScore: MIN_SCORE,
    pollIntervalMs: POLL_MS,
    maxDataAgeSeconds: MAX_AGE,
    lastPollAt,
    lastError,
    polling,
    lockedPairs: [...pairLocks]
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    pairs: PAIRS,
    pollIntervalMs: POLL_MS,
    minScore: MIN_SCORE,
    source: "Twelve Data REST",
    timeframe: "1min"
  });
});

app.get("/api/status", (req, res) => {
  const pair = String(req.query.pair || PAIRS[0] || "");

  if (!results[pair]) {
    return res.status(400).json({
      error: "Unsupported pair",
      pairs: PAIRS
    });
  }

  res.json(results[pair]);
});

app.get("/api/radar", (req, res) => {
  res.json({
    results: PAIRS.map(pair => results[pair]),
    lastPollAt,
    lastError,
    polling
  });
});

// /api/scan?pair=EUR%2FUSD scans the selected pair.
// /api/scan without pair scans the next pair in rotation.
app.get("/api/scan", async (req, res) => {
  const requestedPair = String(req.query.pair || "");

  if (requestedPair && !PAIRS.includes(requestedPair)) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported pair",
      pairs: PAIRS
    });
  }

  if (requestedPair) {
    const result = await pollPair(requestedPair);
    return res.json({
      ok: true,
      scannedPair: requestedPair,
      result,
      lastPollAt,
      lastError
    });
  }

  await pollCycle();

  res.json({
    ok: true,
    scannedPair: null,
    results: PAIRS.map(pair => results[pair]),
    lastPollAt,
    lastError
  });
});

app.get("/api/history", (req, res) => {
  res.json(history);
});

app.get("/api/diagnostics", (req, res) => {
  const now = Date.now();

  res.json({
    now: new Date(now).toISOString(),
    apiKeyConfigured: Boolean(API_KEY),
    pairs: PAIRS,
    lastPollAt,
    lastError,
    polling,
    results
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`AI Signal Radar listening on port ${PORT}`);
  console.log(`Pairs: ${PAIRS.join(", ")}`);
  console.log(`Twelve Data key configured: ${Boolean(API_KEY)}`);
  console.log(`Poll interval: ${POLL_MS}ms`);

  pollCycle().catch(error => console.error(error.message));

  setInterval(() => {
    pollCycle().catch(error => console.error(error.message));
  }, POLL_MS);
});
