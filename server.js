const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;
const APP_ID = process.env.DERIV_APP_ID || "1089";

app.use(express.static("public"));
app.use(express.json());

const SYMBOLS = {
  frxEURUSD: "EUR/USD",
  frxGBPUSD: "GBP/USD",
  frxUSDJPY: "USD/JPY",
  frxAUDUSD: "AUD/USD",
  frxUSDCAD: "USD/CAD"
};

let socket = null;
let connected = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let nextReqId = 1;
let lastError = null;

let selectedSymbol = "frxEURUSD";
let duration = 60;
let threshold = 65;

const prices = {};
const lastTickBySymbol = {};
const candlesBySymbol = {};
const historyRequests = new Map();
const tickSubscriptions = new Set();

for (const symbol of Object.keys(SYMBOLS)) {
  candlesBySymbol[symbol] = [];
}

function send(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return null;
  const req_id = nextReqId++;
  socket.send(JSON.stringify({ ...data, req_id }));
  return req_id;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function addCandle(symbol, candle) {
  const list = candlesBySymbol[symbol];
  const time = Number(candle.time);
  if (!Number.isFinite(time)) return;

  const index = list.findIndex(c => c.time === time);
  if (index >= 0) {
    list[index] = { ...list[index], ...candle };
  } else {
    list.push(candle);
  }

  list.sort((a, b) => a.time - b.time);
  if (list.length > 500) {
    list.splice(0, list.length - 500);
  }
}

function addTick(symbol, quote, epoch) {
  if (!SYMBOLS[symbol]) return;
  if (!Number.isFinite(quote) || !Number.isFinite(epoch)) return;

  prices[symbol] = quote;
  lastTickBySymbol[symbol] = Date.now();

  const time = Math.floor(epoch / 60) * 60000;
  const list = candlesBySymbol[symbol];
  let candle = list[list.length - 1];

  if (!candle || candle.time !== time) {
    candle = { time, open: quote, high: quote, low: quote, close: quote };
    addCandle(symbol, candle);
  } else {
    candle.high = Math.max(candle.high, quote);
    candle.low = Math.min(candle.low, quote);
    candle.close = quote;
  }
}

function analyse(symbol) {
  const candles = candlesBySymbol[symbol] || [];
  const age = Date.now() - (lastTickBySymbol[symbol] || 0);

  if (!connected || age > 15000) {
    return {
      direction: "WAIT",
      score: 0,
      reason: "กำลังรอฟีดข้อมูลราคาสด..."
    };
  }

  if (candles.length < 35) {
    return {
      direction: "WAIT",
      score: 0,
      reason: `กำลังรวบรวมแท่งเทียน (${candles.length}/35)`
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const e6 = ema(closes, 6);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes);

  let up = 0;
  let down = 0;
  const reasons = [];

  if (e6 > e21) {
    up += 2;
    reasons.push("EMA6 > EMA21");
  } else if (e6 < e21) {
    down += 2;
    reasons.push("EMA6 < EMA21");
  }

  if (e50 !== null) {
    if (last.close > e50) up++;
    else if (last.close < e50) down++;
  }

  if (r !== null) {
    if (r >= 52 && r <= 68) up++;
    if (r >= 32 && r <= 48) down++;
  }

  const range = last.high - last.low;
  const body = last.close - last.open;

  if (range > 0 && Math.abs(body) / range > 0.55) {
    if (body > 0) up++;
    else down++;
  }

  if (last.close > prev.close) up++;
  else if (last.close < prev.close) down++;

  const macd = ema(closes, 12) - ema(closes, 26);
  const previousCloses = closes.slice(0, -1);
  const prevMacd = ema(previousCloses, 12) - ema(previousCloses, 26);

  if (macd > 0 && macd >= prevMacd) up += 2;
  else if (macd < 0 && macd <= prevMacd) down += 2;

  const score = Math.min(100, Math.round((Math.max(up, down) / 8) * 100));
  let direction = "WAIT";

  if (up >= 5 && up - down >= 2 && score >= threshold) {
    direction = "CALL";
  } else if (down >= 5 && down - up >= 2 && score >= threshold) {
    direction = "PUT";
  }

  return {
    direction,
    score,
    reason: reasons.join(" · ") || "ตลาดยังไม่เข้าเกณฑ์ชัดเจน",
    indicators: {
      ema6: e6,
      ema21: e21,
      ema50: e50,
      rsi: r,
      macd,
      upScore: up,
      downScore: down
    },
    candleTime: last.time
  };
}

function snapshot() {
  const symbol = selectedSymbol;
  const lastTick = lastTickBySymbol[symbol] || 0;
  const age = lastTick ? Date.now() - lastTick : null;

  return {
    connected,
    fresh: connected && age !== null && age <= 15000,
    error: lastError,
    symbol,
    symbolName: SYMBOLS[symbol],
    duration,
    threshold,
    price: prices[symbol] ?? null,
    lastTick,
    ageMs: age,
    candleCount: candlesBySymbol[symbol].length,
    source: "Deriv Live Feed",
    signal: analyse(symbol)
  };
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true, connected, time: new Date().toISOString() });
});

app.get("/api/status", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json(snapshot());
});

app.post("/api/settings", (req, res) => {
  const { symbol, duration: d, threshold: t } = req.body || {};

  if (symbol !== undefined && !SYMBOLS[symbol]) {
    return res.status(400).json({ error: "คู่เงินไม่ถูกต้อง" });
  }
  if (d !== undefined && (!Number.isInteger(d) || d < 5 || d > 300)) {
    return res.status(400).json({ error: "เวลาเทรดต้อง 5–300 วินาที" });
  }
  if (t !== undefined && (!Number.isInteger(t) || t < 40 || t > 90)) {
    return res.status(400).json({ error: "ค่าเกณฑ์ต้อง 40–90" });
  }

  if (symbol) selectedSymbol = symbol;
  if (d !== undefined) duration = d;
  if (t !== undefined) threshold = t;

  res.set("Cache-Control", "no-store");
  res.json(snapshot());
});

function subscribeMarket(symbol) {
  const reqId = send({
    ticks_history: symbol,
    end: "latest",
    count: 100,
    style: "candles",
    granularity: 60
  });

  if (reqId !== null) {
    historyRequests.set(reqId, symbol);
  }

  if (!tickSubscriptions.has(symbol)) {
    const tickReqId = send({ ticks: symbol, subscribe: 1 });
    if (tickReqId !== null) tickSubscriptions.add(symbol);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  connected = false;
  tickSubscriptions.clear();
  historyRequests.clear();

  try {
    socket = new WebSocket(
      `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      }
    );
  } catch (error) {
    lastError = error.message;
    scheduleReconnect();
    return;
  }

  socket.on("open", () => {
    connected = true;
    reconnectDelay = 1000;
    lastError = null;
    send({ active_symbols: "brief" });
  });

  socket.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.error) {
      lastError = msg.error.message || "Deriv API Error";
      return;
    }

    if (msg.msg_type === "active_symbols") {
      const available = new Set((msg.active_symbols || []).map(item => item.symbol));
      for (const symbol of Object.keys(SYMBOLS)) {
        if (available.has(symbol)) subscribeMarket(symbol);
      }
    }

    if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
      const symbol = historyRequests.get(msg.req_id);
      if (!symbol || !SYMBOLS[symbol]) return;

      for (const c of msg.candles) {
        addCandle(symbol, {
          time: Number(c.epoch) * 1000,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        });
      }
      historyRequests.delete(msg.req_id);
    }

    if (msg.msg_type === "tick" && msg.tick) {
      addTick(msg.tick.symbol, Number(msg.tick.quote), Number(msg.tick.epoch));
    }
  });

  socket.on("error", error => {
    lastError = error.message || "WebSocket error";
  });

  socket.on("close", () => {
    connected = false;
    tickSubscriptions.clear();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Signal Pro Server running on port ${PORT}`);
  connect();
});
