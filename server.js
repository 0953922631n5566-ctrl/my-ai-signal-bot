
"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.DERIV_APP_ID || "1089";
const DERIV_URL =
  `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const SYMBOLS = {
  frxEURUSD: "EUR/USD",
  frxGBPUSD: "GBP/USD",
  frxUSDJPY: "USD/JPY",
  frxAUDUSD: "AUD/USD",
  frxUSDCAD: "USD/CAD",
  frxNZDUSD: "NZD/USD",
  frxUSDCHF: "USD/CHF"
};

const CONFIG = {
  candleSeconds: 60,
  minScore: 70,
  maxDataAgeMs: 15000,
  signalHoldSeconds: 40
};

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

let upstream;
let upstreamConnected = false;
let upstreamLastMessage = 0;
let reconnectTimer;
let reconnectDelay = 1000;
let reconnectScheduled = false;

const candles = {};
const latestPrices = {};
const lastSignals = {};
const clients = new Set();
const signalHistory = [];
const lastSignalEpoch = {};
const lastAnalysis = {};

for (const symbol of Object.keys(SYMBOLS)) {
  candles[symbol] = [];
  latestPrices[symbol] = null;
  lastSignals[symbol] = null;
  lastSignalEpoch[symbol] = 0;
  lastAnalysis[symbol] = null;
}

function sendUpstream(payload) {
  if (upstream && upstream.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function connectUpstream() {
  reconnectScheduled = false;
  clearTimeout(reconnectTimer);

  upstream = new WebSocket(DERIV_URL);

  upstream.on("open", () => {
    upstreamConnected = true;
    upstreamLastMessage = Date.now();
    reconnectDelay = 1000;

    broadcast("connection", {
      connected: true,
      source: "Deriv public market data"
    });

    // Request historical one-minute candles and subscribe
    // to updates for each symbol.
    for (const symbol of Object.keys(SYMBOLS)) {
      sendUpstream({
        ticks_history: symbol,
        end: "latest",
        count: 200,
        style: "candles",
        granularity: 60,
        subscribe: 1
      });
    }
  });

  upstream.on("message", (raw) => {
    upstreamLastMessage = Date.now();

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.error) {
      broadcast("feedError", {
        message: message.error.message || "Upstream data error"
      });
      return;
    }

    if (message.msg_type === "candles" && message.candles) {
      const symbol = message.echo_req?.ticks_history;
      if (!SYMBOLS[symbol]) return;

      candles[symbol] = message.candles
        .map(normalizeCandle)
        .filter(Boolean)
        .slice(-500);

      const last = candles[symbol].at(-1);
      if (last) {
        latestPrices[symbol] = {
          price: last.close,
          time: last.epoch * 1000,
          receivedAt: Date.now()
        };
      }

      analyze(symbol);
      broadcast("market", snapshot());
      return;
    }

    if (message.msg_type === "ohlc" && message.ohlc) {
      const symbol = message.ohlc.symbol ||
        message.echo_req?.ticks_history;

      if (!SYMBOLS[symbol]) return;

      updateCandle(symbol, message.ohlc);
      return;
    }
  });

  upstream.on("error", () => {
    upstreamConnected = false;
    broadcast("connection", { connected: false });
  });

  upstream.on("close", () => {
    upstreamConnected = false;
    broadcast("connection", { connected: false });

    if (!reconnectScheduled) {
      reconnectScheduled = true;
      reconnectTimer = setTimeout(connectUpstream, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }
  });
}

function normalizeCandle(c) {
  const epoch = Number(c.epoch);
  const open = Number(c.open);
  const high = Number(c.high);
  const low = Number(c.low);
  const close = Number(c.close);

  if (![epoch, open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  return { epoch, open, high, low, close };
}

function updateCandle(symbol, raw) {
  const candle = normalizeCandle(raw);
  if (!candle) return;

  const list = candles[symbol];
  const previous = list.at(-1);

  if (!previous) {
    list.push(candle);
  } else if (candle.epoch === previous.epoch) {
    list[list.length - 1] = candle;
  } else if (candle.epoch > previous.epoch) {
    // The previous candle has ended. Analyze only after
    // the feed advances to a new candle.
    list.push(candle);
    if (list.length > 500) list.shift();
  } else {
    return; // Ignore out-of-order updates.
  }

  latestPrices[symbol] = {
    price: candle.close,
    time: candle.epoch * 1000,
    receivedAt: Date.now()
  };

  analyze(symbol);
  broadcast("market", snapshot());
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) +
      Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) +
      Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function analyze(symbol) {
  const list = candles[symbol];
  if (!list || list.length < 60) {
    lastAnalysis[symbol] = {
      symbol,
      pair: SYMBOLS[symbol],
      signal: "STANDBY",
      score: 0,
      reason: "Waiting for at least 60 candles",
      price: latestPrices[symbol]?.price ?? null,
      updatedAt: Date.now()
    };
    return;
  }

  // The current candle may still be forming. Analyze
  // only the candles before the latest one.
  const closed = list.slice(0, -1);
  const closes = closed.map(c => c.close);

  if (closes.length < 55) return;

  const fast = ema(closes, 6);
  const medium = ema(closes, 21);
  const slow = ema(closes, 50);
  const rsiValue = rsi(closes, 14);

  const macdLine = ema(closes, 12) - ema(closes, 26);
  const macdSignal = ema(
    closes.map((_, i) => {
      const subset = closes.slice(0, i + 1);
      return ema(subset, 12) - ema(subset, 26) || 0;
    }),
    9
  );

  const previous = closed.at(-1);
  const prior = closed.at(-2);

  let up = 0;
  let down = 0;
  const reasons = [];

  if (fast > medium && medium > slow) {
    up += 30;
    reasons.push("EMA trend bullish");
  } else if (fast < medium && medium < slow) {
    down += 30;
    reasons.push("EMA trend bearish");
  }

  if (rsiValue >= 52 && rsiValue <= 68) {
    up += 20;
    reasons.push("RSI bullish momentum");
  } else if (rsiValue <= 48 && rsiValue >= 32) {
    down += 20;
    reasons.push("RSI bearish momentum");
  }

  if (macdLine > macdSignal) {
    up += 20;
    reasons.push("MACD bullish");
  } else if (macdLine < macdSignal) {
    down += 20;
    reasons.push("MACD bearish");
  }

  if (previous.close > previous.open &&
      previous.close > prior.close) {
    up += 15;
  } else if (previous.close < previous.open &&
             previous.close < prior.close) {
    down += 15;
  }

  // Penalize very small candles / low momentum.
  const range = previous.high - previous.low;
  const body = Math.abs(previous.close - previous.open);

  if (range > 0 && body / range >= 0.55) {
    if (previous.close > previous.open) up += 15;
    else if (previous.close < previous.open) down += 15;
  }

  let signal = "STANDBY";
  let score = Math.max(up, down);

  if (up >= CONFIG.minScore && up > down) {
    signal = "CALL";
  } else if (down >= CONFIG.minScore && down > up) {
    signal = "PUT";
  } else {
    score = Math.max(up, down);
  }

  const result = {
    symbol,
    pair: SYMBOLS[symbol],
    signal,
    score,
    rsi: Number(rsiValue.toFixed(2)),
    emaFast: fast,
    emaMedium: medium,
    emaSlow: slow,
    price: latestPrices[symbol]?.price ?? list.at(-1).close,
    candleEpoch: previous.epoch,
    reason: signal === "STANDBY"
      ? "No clear high-confluence setup"
      : reasons.join(" · "),
    updatedAt: Date.now()
  };

  lastAnalysis[symbol] = result;

  // At most one signal per pair per closed candle.
  if (
    signal !== "STANDBY" &&
    lastSignalEpoch[symbol] !== previous.epoch
  ) {
    lastSignalEpoch[symbol] = previous.epoch;

    lastSignals[symbol] = {
      ...result,
      createdAt: Date.now(),
      expiresAt: Date.now() +
        CONFIG.signalHoldSeconds * 1000
    };

    signalHistory.unshift(lastSignals[symbol]);
    if (signalHistory.length > 500) signalHistory.pop();

    broadcast("signal", lastSignals[symbol]);
  }
}

function snapshot() {
  const now = Date.now();

  return {
    connected: upstreamConnected,
    dataFresh: upstreamConnected &&
      now - upstreamLastMessage < CONFIG.maxDataAgeMs,
    source: "Deriv public market data",
    timeframe: "1M",
    serverTime: now,
    config: CONFIG,
    pairs: Object.keys(SYMBOLS).map(symbol => ({
      symbol,
      pair: SYMBOLS[symbol],
      price: latestPrices[symbol]?.price ?? null,
      receivedAt: latestPrices[symbol]?.receivedAt ?? null,
      analysis: lastAnalysis[symbol] ?? {
        signal: "STANDBY",
        score: 0,
        reason: "Waiting for market data"
      }
    })),
    signals: signalHistory.slice(0, 20)
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    connected: upstreamConnected,
    dataFresh: upstreamConnected &&
      Date.now() - upstreamLastMessage < CONFIG.maxDataAgeMs,
    source: "Deriv public market data",
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_req, res) => {
  res.json(snapshot());
});

app.get("/api/history", (_req, res) => {
  res.json(signalHistory.slice(0, 100));
});

app.get("/api/settings", (_req, res) => {
  res.json(CONFIG);
});

app.post("/api/settings", (req, res) => {
  const threshold = Number(req.body.minScore);

  if (!Number.isFinite(threshold) ||
      threshold < 70 || threshold > 100) {
    return res.status(400).json({
      error: "minScore must be between 70 and 100"
    });
  }

  CONFIG.minScore = threshold;
  res.json({ ok: true, config: CONFIG });
});

wss.on("connection", (client) => {
  clients.add(client);

  client.send(JSON.stringify({
    type: "market",
    data: snapshot()
  }));

  client.on("close", () => clients.delete(client));
  client.on("error", () => clients.delete(client));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Signal server listening on ${PORT}`);
  connectUpstream();
});

// Keep the process responsive but never present stale data as live.
setInterval(() => {
  if (
    upstreamConnected &&
    Date.now() - upstreamLastMessage > 30000
  ) {
    try {
      upstream.terminate();
    } catch {}
  }

  broadcast("heartbeat", {
    connected: upstreamConnected,
    dataFresh: upstreamConnected &&
      Date.now() - upstreamLastMessage <
      CONFIG.maxDataAgeMs,
    serverTime: Date.now()
  });
}, 2000);
