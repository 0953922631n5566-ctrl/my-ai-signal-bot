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

// ดึงข้อมูลทุก 2 นาทีเพื่อประหยัดโควต้าฟรี
const POLL_INTERVAL_MS = Math.max(
  120000,
  Number(process.env.POLL_INTERVAL_MS || 120000)
);

const STALE_AFTER_MS = 4 * 60 * 1000;
const MIN_CANDLES = 50;

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
  symbol: "EUR/USD",
  interval: "1min",
  threshold: 65,
  candles: [],
  price: null,
  signal: "STANDBY",
  score: 0,
  rsi: null,
  trend: "ไม่ระบุ",
  reason: "กำลังรอข้อมูลตลาดสด",
  lastUpdated: null,
  lastCandleTime: null,
  lastError: null,
  apiCalls: 0,
  pairsCache: {}
};

let pollTimer = null;
let pollInProgress = false;

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
  return Date.now() - new Date(state.lastUpdated).getTime() <= STALE_AFTER_MS;
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
  let gains = 0, losses = 0;
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

function analyzeCandles(candles) {
  const closes = candles.map((c) => c.close);
  if (closes.length < MIN_CANDLES) {
    return {
      signal: "STANDBY",
      score: 0,
      rsi: null,
      trend: "ไม่ระบุ",
      reason: "แท่งเทียนย้อนหลังยังไม่เพียงพอสำหรับการวิเคราะห์"
    };
  }

  const ema6 = ema(closes, 6);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi = calculateRsi(closes, 14);

  const last = closes.length - 1;
  const latest = candles[last];
  const previous = candles[last - 1] || latest;

  let bullish = 0, bearish = 0;
  const reasons = [];

  if (ema6[last] > ema21[last]) bullish += 25;
  else if (ema6[last] < ema21[last]) bearish += 25;

  if (ema21[last] > ema50[last]) bullish += 25;
  else if (ema21[last] < ema50[last]) bearish += 25;

  if (rsi >= 52 && rsi <= 68) bullish += 20;
  else if (rsi <= 48 && rsi >= 32) bearish += 20;

  if (latest.close > latest.open) bullish += 15;
  else if (latest.close < latest.open) bearish += 15;

  if (latest.close > previous.close) bullish += 15;
  else if (latest.close < previous.close) bearish += 15;

  const score = Math.max(bullish, bearish);
  let signal = "STANDBY";

  if (bullish > bearish && bullish >= state.threshold) {
    signal = "CALL";
    reasons.push("แนวโน้มและโมเมนตัมแรงซื้อได้เปรียบ (CALL)");
  } else if (bearish > bullish && bearish >= state.threshold) {
    signal = "PUT";
    reasons.push("แนวโน้มและโมเมนตัมแรงขายได้เปรียบ (PUT)");
  } else {
    reasons.push("สัญญาณทางเทคนิคยังไม่ชัดเจน ควรรอจังหวะ");
  }

  return {
    signal,
    score,
    rsi: round(rsi, 2),
    trend: ema21[last] > ema50[last] ? "ขาขึ้น" : ema21[last] < ema50[last] ? "ขาลง" : "ไซด์เวย์",
    reason: reasons.join(" | ")
  };
}

// --------------------------------------------------
// FETCH DATA FROM TWELVE DATA API
// --------------------------------------------------
async function fetchCandles(symbol) {
  if (!API_KEY) {
    throw new Error("ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render Environment Variables");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();

    if (!response.ok || body.status === "error" || !Array.isArray(body.values)) {
      throw new Error(body.message || "ดึงข้อมูลจาก Twelve Data ไม่สำเร็จ");
    }

    return body.values
      .map((item) => ({
        datetime: item.datetime,
        timestamp: Date.parse(`${item.datetime.replace(" ", "T")}Z`),
        open: safeNumber(item.open),
        high: safeNumber(item.high),
        low: safeNumber(item.low),
        close: safeNumber(item.close)
      }))
      .filter((c) => Number.isFinite(c.timestamp) && c.close !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshData(targetSymbol = state.symbol) {
  if (pollInProgress) return;
  pollInProgress = true;
  state.loading = true;

  try {
    const candles = await fetchCandles(targetSymbol);

    state.candles = candles;
    state.price = candles[candles.length - 1].close;
    state.lastCandleTime = candles[candles.length - 1].datetime;
    state.lastUpdated = nowIso();
    state.connected = true;
    state.lastError = null;
    state.apiCalls += 1;

    const analysis = analyzeCandles(candles);
    state.signal = analysis.signal;
    state.score = analysis.score;
    state.rsi = analysis.rsi;
    state.trend = analysis.trend;
    state.reason = analysis.reason;

    state.pairsCache[targetSymbol] = {
      symbol: targetSymbol,
      pair: targetSymbol,
      price: state.price,
      receivedAt: Date.now(),
      analysis: {
        signal: analysis.signal,
        score: analysis.score,
        rsi: analysis.rsi,
        trend: analysis.trend,
        reason: analysis.reason,
        candleEpoch: Date.parse(state.lastCandleTime)
      }
    };

    broadcastMarketData();
  } catch (error) {
    state.connected = false;
    state.lastError = error.message;
    state.reason = error.message;
    broadcastStatus();
  } finally {
    state.loading = false;
    pollInProgress = false;
  }
}

function buildMarketPayload() {
  const pairsList = ALLOWED_SYMBOLS.map((sym) => {
    const cached = state.pairsCache[sym];
    if (cached) return cached;
    return {
      symbol: sym,
      pair: sym,
      price: sym === state.symbol ? state.price : null,
      receivedAt: sym === state.symbol ? Date.now() : null,
      analysis: {
        signal: "STANDBY",
        score: 0,
        rsi: null,
        trend: "รอสแกน",
        reason: "กดสแกนเพื่ออัปเดตราคาล่าสุด",
        candleEpoch: Date.now()
      }
    };
  });

  return {
    connected: state.connected,
    dataFresh: isFresh(),
    pairs: pairsList,
    apiCalls: state.apiCalls
  };
}

function broadcastMarketData() {
  const message = JSON.stringify({
    type: "market",
    data: buildMarketPayload(),
    time: nowIso()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastStatus() {
  const message = JSON.stringify({
    type: "connection",
    data: { connected: state.connected, dataFresh: isFresh() },
    time: nowIso()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// --------------------------------------------------
// WEBSOCKET & HTTP ENDPOINTS
// --------------------------------------------------
wss.on("connection", (socket) => {
  console.log("Client connected. Total:", wss.clients.size);

  socket.send(JSON.stringify({
    type: "connection",
    data: { connected: state.connected, dataFresh: isFresh() },
    time: nowIso()
  }));

  socket.send(JSON.stringify({
    type: "market",
    data: buildMarketPayload(),
    time: nowIso()
  }));

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "set_symbol" && ALLOWED_SYMBOLS.includes(msg.symbol)) {
        state.symbol = msg.symbol;
        refreshData(state.symbol);
      }
      if (msg.type === "manual_scan") {
        if (msg.symbol && ALLOWED_SYMBOLS.includes(msg.symbol)) {
          state.symbol = msg.symbol;
        }
        refreshData(state.symbol);
      }
    } catch {}
  });

  socket.on("close", () => {
    console.log("Client disconnected. Total:", wss.clients.size);
  });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, configured: Boolean(API_KEY), activeClients: wss.clients.size, time: nowIso() });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`เซิร์ฟเวอร์เปิดทำงานที่พอร์ต ${PORT}`);
  
  // Smart Polling: ดึงข้อมูลเมื่อมีผู้ใช้งานเชื่อมต่ออยู่เท่านั้น เพื่อประหยัดโควต้า API
  pollTimer = setInterval(() => {
    if (wss.clients.size > 0) {
      refreshData(state.symbol);
    } else {
      console.log("⏸️ ไม่มีผู้ใช้งานเชื่อมต่อ - หยุดดึง API ชั่วคราว");
    }
  }, POLL_INTERVAL_MS);
});
