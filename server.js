
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = (process.env.TWELVE_DATA_API_KEY || "").trim();

const PAIRS = (process.env.FOREX_PAIRS || "EUR/USD,GBP/USD,USD/JPY")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const MIN_SCORE = clamp(Number(process.env.MIN_SIGNAL_SCORE || 68), 40, 95);
const POLL_MS = clamp(Number(process.env.POLL_INTERVAL_MS || 25000), 15000, 120000);
const MAX_AGE = clamp(Number(process.env.MAX_DATA_AGE_SECONDS || 180), 30, 600);

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round(n, digits = 6) {
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

const results = {};
const history = [];
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
    message: "Waiting for market data",
    updatedAt: null,
    signalId: null,
    stale: true,
    dataAgeSeconds: null,
    indicators: null,
    reasons: [],
    early: null,
    confirmed: null
  };
}

/* ---------- Technical indicators ---------- */

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
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

  if (losses === 0) return 100;

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

/* ---------- Twelve Data ---------- */

function parseCandle(item) {
  const raw = String(item.datetime || "").trim();

  // We request UTC from Twelve Data.
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
    throw new Error("Set TWELVE_DATA_API_KEY in Render Environment");
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

  if (!response.ok || body.status === "error" || !Array.isArray(body.values)) {
    throw new Error(body.message || `Twelve Data HTTP ${response.status}`);
  }

  const candles = body.values
    .map(parseCandle)
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.close)
    )
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error("No candle data received");

  return candles;
}

/* ---------- Signal scoring ---------- */

function analyzeCandles(candles, isEarly = false) {
  if (candles.length < 55) {
    return {
      direction: "STANDBY",
      score: 0,
      reasons: ["Waiting for at least 55 candles"],
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
  const macd = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;

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
    reasons.push(isEarly ? "Forming candle is green" : "Closed candle is green");
  } else if (current.close < current.open) {
    put += 12;
    reasons.push(isEarly ? "Forming candle is red" : "Closed candle is red");
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

/* ---------- Dual scan ---------- */

function processCandles(pair, candles) {
  const now = Date.now();
  const latest = candles[candles.length - 1];

  // One 1-minute candle is considered closed when its start time + 60 seconds
  // is earlier than the current server time. Provider delays can still occur.
  const closedCandles = candles.filter(c => c.time + 60000 <= now);
  const closedLast = closedCandles[closedCandles.length - 1];

  const age = Math.max(0, Math.floor((now - latest.time) / 1000));
  const stale = age > MAX_AGE;

  const early = stale
    ? { direction: "STANDBY", score: 0, reasons: ["Market data is stale"], indicators: null }
    : analyzeCandles(candles, true);

  const confirmed = closedCandles.length >= 55
    ? analyzeCandles(closedCandles, false)
    : { direction: "STANDBY", score: 0, reasons: ["Waiting for closed candles"], indicators: null };

  // Early signal is used only when the newest candle appears to be forming.
  const latestAppearsOpen = latest.time + 60000 > now;

  let chosen;

  if (!stale && latestAppearsOpen && early.direction !== "STANDBY") {
    chosen = { ...early, stage: "EARLY" };
  } else if (!stale && confirmed.direction !== "STANDBY") {
    chosen = { ...confirmed, stage: "CONFIRMED" };
  } else {
    chosen = {
      direction: "STANDBY",
      score: Math.max(early.score || 0, confirmed.score || 0),
      reasons: stale ? ["Market data is stale"] : ["No setup passed the filters"],
      indicators: early.indicators || confirmed.indicators,
      stage: "STANDBY"
    };
  }

  // Use the latest candle timestamp as part of the ID to avoid repeated
  // notifications for the same pair, candle, direction, and scan stage.
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
    dataAgeSeconds: age,
    stale,
    candleTime: (closedLast || latest).datetime,
    latestCandleTime: latest.datetime,
    latestCandleAppearsOpen: latestAppearsOpen,
    candleClosed: chosen.stage === "CONFIRMED",
    updatedAt: new Date().toISOString(),
    signalId,
    source: "Twelve Data REST; not IQ Option feed",
    message: stale
      ? "ข้อมูลราคาเก่า กรุณารอสัญญาณใหม่"
      : chosen.stage === "EARLY"
        ? "สัญญาณเบื้องต้นจากแท่งที่กำลังวิ่ง ราคาอาจเปลี่ยนทิศ"
        : chosen.stage === "CONFIRMED"
          ? "สัญญาณจากแท่งที่ปิดแล้ว"
          : "ยังไม่มีสัญญาณที่ผ่านเงื่อนไข",
    reasons: chosen.reasons || [],
    indicators: chosen.indicators,
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

  if (signalId && (!previous || previous.signalId !== signalId)) {
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

/* ---------- Polling ---------- */

async function pollPair(pair) {
  try {
    const candles = await fetchCandles(pair);
    processCandles(pair, candles);
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
      updatedAt: new Date().toISOString()
    };
  }

  lastPollAt = new Date().toISOString();
}

async function pollCycle() {
  if (polling || PAIRS.length === 0) return;

  polling = true;

  try {
    // Rotate one pair per cycle to reduce API quota use.
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
    lastError
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    pairs: PAIRS,
    pollIntervalMs: POLL_MS,
    minScore: MIN_SCORE,
    source: "Twelve Data REST"
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

app.get("/api/scan", async (req, res) => {
  await pollCycle();

  res.json({
    ok: true,
    results: PAIRS.map(pair => results[pair]),
    lastPollAt,
    lastError
  });
});

app.get("/api/history", (req, res) => {
  res.json(history);
});

app.get("/api/diagnostics", (req, res) => {
  res.json({
    now: new Date().toISOString(),
    apiKeyConfigured: Boolean(API_KEY),
    pairs: PAIRS,
    lastPollAt,
    lastError,
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

  pollCycle().catch(error => console.error(error.message));
  setInterval(() => {
    pollCycle().catch(error => console.error(error.message));
  }, POLL_MS);
});
