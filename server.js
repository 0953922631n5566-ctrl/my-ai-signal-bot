
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.DERIV_APP_ID || "1089";
const STORE = path.join(__dirname, "signals.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SYMBOLS = {
  frxEURUSD: "EUR/USD",
  frxGBPUSD: "GBP/USD",
  frxUSDJPY: "USD/JPY",
  frxAUDUSD: "AUD/USD",
  frxUSDCAD: "USD/CAD"
};

const state = {
  connected: false,
  source: "Deriv reference feed — not IQ Option OTC",
  symbol: "frxEURUSD",
  duration: 60,
  threshold: 65,
  candles: {},
  prices: {},
  signal: null,
  lastSignalCandle: null,
  lastTick: 0,
  error: null
};

let deriv;
let reconnectTimer;
let requestId = 1;
const pending = new Map();

function readHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let history = readHistory();

function saveHistory() {
  try {
    fs.writeFileSync(STORE, JSON.stringify(history.slice(-5000), null, 2));
  } catch (e) {
    console.error("Save history failed:", e.message);
  }
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }

  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function macd(values) {
  if (values.length < 35) return null;
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const previous = values.slice(0, -1);
  const prevFast = ema(previous, 12);
  const prevSlow = ema(previous, 26);

  if ([fast, slow, prevFast, prevSlow].some(v => v === null)) return null;
  return {
    value: fast - slow,
    previous: prevFast - prevSlow
  };
}

function analyse(candles) {
  if (candles.length < 35) {
    return {
      direction: "WAIT",
      score: 0,
      reason: "รอข้อมูลราคาอย่างน้อย 35 แท่ง"
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const e6 = ema(closes, 6);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes);
  const m = macd(closes);

  let up = 0;
  let down = 0;
  const reasons = [];

  if (e6 !== null && e21 !== null) {
    if (e6 > e21) {
      up += 2;
      reasons.push("EMA ระยะสั้นอยู่เหนือ EMA21");
    } else if (e6 < e21) {
      down += 2;
      reasons.push("EMA ระยะสั้นอยู่ใต้ EMA21");
    }
  }

  if (e50 !== null) {
    if (last.close > e50) up++;
    else if (last.close < e50) down++;
  }

  if (m) {
    if (m.value > 0 && m.value >= m.previous) {
      up += 2;
      reasons.push("MACD สนับสนุนโมเมนตัมขึ้น");
    } else if (m.value < 0 && m.value <= m.previous) {
      down += 2;
      reasons.push("MACD สนับสนุนโมเมนตัมลง");
    }
  }

  if (r !== null) {
    if (r >= 52 && r <= 68) up++;
    else if (r <= 48 && r >= 32) down++;
    else if (r > 75 || r < 25) {
      reasons.push("RSI อยู่ในเขตสุดโต่ง ควรระวังการกลับตัว");
    }
  }

  const body = last.close - last.open;
  const range = last.high - last.low;
  if (range > 0) {
    const bodyRatio = Math.abs(body) / range;
    if (bodyRatio > 0.55 && body > 0) up++;
    else if (bodyRatio > 0.55 && body < 0) down++;
  }

  if (last.close > prev.close) up++;
  else if (last.close < prev.close) down++;

  const total = Math.max(up, down);
  const gap = Math.abs(up - down);
  const score = Math.round(Math.min(100, total / 8 * 100));

  let direction = "WAIT";
  if (up >= 5 && gap >= 2 && score >= state.threshold) direction = "CALL";
  if (down >= 5 && gap >= 2 && score >= state.threshold) direction = "PUT";

  return {
    direction,
    score,
    indicators: {
      ema6: e6,
      ema21: e21,
      ema50: e50,
      rsi: r,
      macd: m?.value ?? null,
      upScore: up,
      downScore: down
    },
    reason: reasons.join(" · ") || "สัญญาณยังไม่สอดคล้องกัน",
    candleTime: last.time
  };
}

function getCandles(symbol) {
  if (!state.candles[symbol]) state.candles[symbol] = [];
  return state.candles[symbol];
}

function broadcast() {
  const payload = JSON.stringify({
    type: "update",
    data: snapshot()
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function snapshot() {
  const candles = getCandles(state.symbol);
  const age = state.lastTick ? Date.now() - state.lastTick : Infinity;
  const fresh = age < 15000;
  const result = fresh ? analyse(candles) : {
    direction: "WAIT",
    score: 0,
    reason: "ข้อมูลราคาไม่อัปเดตหรือขาดการเชื่อมต่อ"
  };

  return {
    connected: state.connected,
    fresh,
    source: state.source,
    symbol: state.symbol,
    symbolName: SYMBOLS[state.symbol] || state.symbol,
    duration: state.duration,
    price: state.prices[state.symbol] ?? null,
    candleCount: candles.length,
    lastTickAgeMs: Number.isFinite(age) ? age : null,
    signal: result,
    recent: history.slice(-30).reverse(),
    stats: calculateStats()
  };
}

function calculateStats() {
  const closed = history.filter(x => x.outcome === "WIN" || x.outcome === "LOSS");
  const wins = closed.filter(x => x.outcome === "WIN").length;
  return {
    total: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? Math.round(wins / closed.length * 100) : null
  };
}

function settleExpiredSignals(symbol, price, timestamp) {
  for (const item of history) {
    if (item.outcome !== "PENDING") continue;
    if (item.symbol !== symbol) continue;
    if (timestamp < item.expiry) continue;

    item.exitPrice = price;
    if (price === item.entryPrice) {
      item.outcome = "DRAW";
    } else {
      const won =
        (item.direction === "CALL" && price > item.entryPrice) ||
        (item.direction === "PUT" && price < item.entryPrice);
      item.outcome = won ? "WIN" : "LOSS";
    }
    item.closedAt = new Date().toISOString();
    saveHistory();
  }
}

function acceptTick(symbol, quote, epoch) {
  if (!Number.isFinite(quote) || !Number.isFinite(epoch)) return;

  const timestamp = epoch * 1000;
  state.lastTick = Date.now();
  state.prices[symbol] = quote;

  settleExpiredSignals(symbol, quote, timestamp);

  const minute = Math.floor(timestamp / 60000) * 60000;
  const candles = getCandles(symbol);
  let current = candles[candles.length - 1];

  if (!current || current.time !== minute) {
    current = {
      time: minute,
      open: quote,
      high: quote,
      low: quote,
      close: quote
    };
    candles.push(current);
    if (candles.length > 500) candles.shift();
  } else {
    current.high = Math.max(current.high, quote);
    current.low = Math.min(current.low, quote);
    current.close = quote;
  }

  if (symbol === state.symbol) {
    const analysis = analyse(candles);
    if (
      analysis.direction !== "WAIT" &&
      analysis.candleTime !== state.lastSignalCandle &&
      candles.length >= 35
    ) {
      state.signal = {
        ...analysis,
        id: `${symbol}-${minute}`,
        symbol,
        entryPrice: quote,
        createdAt: new Date().toISOString(),
        expiry: timestamp + state.duration * 1000,
        outcome: "PENDING"
      };

      state.lastSignalCandle = analysis.candleTime;
      history.push(state.signal);
      saveHistory();
    }
  }
}

function sendDeriv(message) {
  if (!deriv || deriv.readyState !== WebSocket.OPEN) return;
  deriv.send(JSON.stringify(message));
}

function connectDeriv() {
  clearTimeout(reconnectTimer);
  state.connected = false;
  state.error = null;

  deriv = new WebSocket(
    `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`
  );

  deriv.on("open", () => {
    state.connected = true;
    sendDeriv({
      active_symbols: "brief",
      product_type: "basic",
      req_id: requestId++
    });
    broadcast();
  });

  deriv.on("message", raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.error) {
      state.error = msg.error.message || "Deriv API error";
      console.error("Deriv:", state.error);
      broadcast();
      return;
    }

    if (msg.msg_type === "active_symbols" && Array.isArray(msg.active_symbols)) {
      const available = new Set(msg.active_symbols.map(x => x.symbol));
      for (const symbol of Object.keys(SYMBOLS)) {
        if (available.has(symbol)) {
          sendDeriv({
            ticks: symbol,
            subscribe: 1,
            req_id: requestId++
          });
        }
      }
    }

    if (msg.msg_type === "tick" && msg.tick) {
      acceptTick(
        msg.tick.symbol,
        Number(msg.tick.quote),
        Number(msg.tick.epoch)
      );
      broadcast();
    }
  });

  deriv.on("close", () => {
    state.connected = false;
    broadcast();
    reconnectTimer = setTimeout(connectDeriv, 3000);
  });

  deriv.on("error", err => {
    state.error = err.message;
    console.error("WebSocket error:", err.message);
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    connected: state.connected,
    error: state.error
  });
});

app.get("/api/status", (req, res) => {
  res.json(snapshot());
});

app.get("/api/history", (req, res) => {
  res.json(history.slice(-500).reverse());
});

app.post("/api/settings", (req, res) => {
  const { symbol, duration, threshold } = req.body || {};

  if (symbol && !SYMBOLS[symbol]) {
    return res.status(400).json({ error: "Unsupported symbol" });
  }
  if (duration !== undefined &&
      (!Number.isInteger(duration) || duration < 5 || duration > 300)) {
    return res.status(400).json({ error: "Duration must be 5–300 seconds" });
  }
  if (threshold !== undefined &&
      (!Number.isInteger(threshold) || threshold < 40 || threshold > 90)) {
    return res.status(400).json({ error: "Threshold must be 40–90" });
  }

  if (symbol) state.symbol = symbol;
  if (duration !== undefined) state.duration = duration;
  if (threshold !== undefined) state.threshold = threshold;

  broadcast();
  res.json(snapshot());
});

app.post("/api/record", (req, res) => {
  const { id, outcome } = req.body || {};
  if (!["WIN", "LOSS", "DRAW"].includes(outcome)) {
    return res.status(400).json({ error: "Invalid outcome" });
  }

  const item = history.find(x => x.id === id);
  if (!item) return res.status(404).json({ error: "Signal not found" });

  item.outcome = outcome;
  item.manuallyRecorded = true;
  item.closedAt = new Date().toISOString();
  saveHistory();
  broadcast();
  res.json({ ok: true, stats: calculateStats() });
});

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type: "update", data: snapshot() }));
});

setInterval(broadcast, 1000);

server.listen(PORT, () => {
  console.log(`AI Signal System running at http://localhost:${PORT}`);
  connectDeriv();
});
