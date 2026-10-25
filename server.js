
const express = require("express");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 10000;
const APP_ID = process.env.DERIV_APP_ID || "1089";

app.use(express.static("public"));
app.get("/api/health", (_, res) => {
  res.json({ ok: true, connected, lastTick });
});

const SYMBOLS = {
  frxEURUSD: "EUR/USD",
  frxGBPUSD: "GBP/USD",
  frxUSDJPY: "USD/JPY",
  frxAUDUSD: "AUD/USD",
  frxUSDCAD: "USD/CAD"
};

let connected = false;
let lastTick = 0;
let socket;
let reconnectTimer;
let requestId = 1;
let selectedSymbol = "frxEURUSD";
let duration = 60;
let threshold = 65;
let candlesBySymbol = {};
let prices = {};
let errors = null;

for (const s of Object.keys(SYMBOLS)) candlesBySymbol[s] = [];

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let out = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    out = values[i] * k + out * (1 - k);
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}

function analyse(symbol) {
  const candles = candlesBySymbol[symbol] || [];
  const age = Date.now() - lastTick;

  if (!connected || age > 15000) {
    return { direction: "WAIT", score: 0, reason: "ข้อมูลราคาไม่สด" };
  }
  if (candles.length < 35) {
    return {
      direction: "WAIT",
      score: 0,
      reason: `กำลังรวบรวมข้อมูล ${candles.length}/35 แท่ง`
    };
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const e6 = ema(closes, 6);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes);

  let up = 0, down = 0;
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

  const body = last.close - last.open;
  const range = last.high - last.low;
  if (range > 0 && Math.abs(body) / range > 0.55) {
    if (body > 0) up++;
    else down++;
  }

  if (last.close > prev.close) up++;
  else if (last.close < prev.close) down++;

  // MACD line: EMA12 minus EMA26
  const macd = ema(closes, 12) - ema(closes, 26);
  const previousCloses = closes.slice(0, -1);
  const prevMacd = ema(previousCloses, 12) - ema(previousCloses, 26);

  if (macd > 0 && macd >= prevMacd) up += 2;
  else if (macd < 0 && macd <= prevMacd) down += 2;

  const gap = Math.abs(up - down);
  const score = Math.min(100, Math.round(Math.max(up, down) / 8 * 100));

  let direction = "WAIT";
  if (up >= 5 && gap >= 2 && score >= threshold) direction = "CALL";
  if (down >= 5 && gap >= 2 && score >= threshold) direction = "PUT";

  return {
    direction,
    score,
    reason: reasons.join(" · ") || "เงื่อนไขยังไม่ตรงกัน",
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
  const candles = candlesBySymbol[selectedSymbol] || [];
  return {
    connected,
    fresh: connected && Date.now() - lastTick <= 15000,
    error: errors,
    symbol: selectedSymbol,
    symbolName: SYMBOLS[selectedSymbol],
    duration,
    threshold,
    price: prices[selectedSymbol] ?? null,
    lastTick,
    candleCount: candles.length,
    source: "Deriv live reference feed — not IQ Option OTC",
    signal: analyse(selectedSymbol)
  };
}

app.get("/api/status", (_, res) => res.json(snapshot()));

app.post("/api/settings", express.json(), (req, res) => {
  const { symbol, duration: d, threshold: t } = req.body || {};

  if (symbol !== undefined && !SYMBOLS[symbol]) {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  if (d !== undefined && (!Number.isInteger(d) || d < 5 || d > 300)) {
    return res.status(400).json({ error: "Duration must be 5–300 seconds" });
  }
  if (t !== undefined && (!Number.isInteger(t) || t < 40 || t > 90)) {
    return res.status(400).json({ error: "Threshold must be 40–90" });
  }

  if (symbol) selectedSymbol = symbol;
  if (d !== undefined) duration = d;
  if (t !== undefined) threshold = t;
  res.json(snapshot());
});

function send(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ ...data, req_id: requestId++ }));
  }
}

function addTick(symbol, quote, epoch) {
  if (!SYMBOLS[symbol] || !Number.isFinite(quote) || !Number.isFinite(epoch)) return;

  lastTick = Date.now();
  prices[symbol] = quote;

  const time = Math.floor(epoch / 60) * 60000;
  const list = candlesBySymbol[symbol];
  let candle = list[list.length - 1];

  if (!candle || candle.time !== time) {
    candle = { time, open: quote, high: quote, low: quote, close: quote };
    list.push(candle);
    if (list.length > 500) list.shift();
  } else {
    candle.high = Math.max(candle.high, quote);
    candle.low = Math.min(candle.low, quote);
    candle.close = quote;
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  connected = false;

  socket = new WebSocket(
    `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(APP_ID)}`
  );

  socket.on("open", () => {
    connected = true;
    errors = null;
    send({ active_symbols: "brief" });
  });

  socket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.error) {
      errors = msg.error.message || "Market API error";
      console.error(errors);
      return;
    }

    if (msg.msg_type === "active_symbols") {
      const available = new Set((msg.active_symbols || []).map(x => x.symbol));

      for (const symbol of Object.keys(SYMBOLS)) {
        if (!available.has(symbol)) continue;

        // Load recent 1-minute candles first.
        send({
          ticks_history: symbol,
          end: "latest",
          count: 100,
          style: "candles",
          granularity: 60
        });

        // Then subscribe to live prices.
        send({ ticks: symbol, subscribe: 1 });
      }
    }

    if (msg.msg_type === "candles" && Array.isArray(msg.candles)) {
      const symbol = msg.echo_req?.ticks_history;
      if (!SYMBOLS[symbol]) return;

      const old = candlesBySymbol[symbol];
      const map = new Map(old.map(c => [c.time, c]));

      for (const c of msg.candles) {
        const time = Number(c.epoch) * 1000;
        map.set(time, {
          time,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close)
        });
      }

      candlesBySymbol[symbol] = [...map.values()]
        .sort((a, b) => a.time - b.time)
        .slice(-500);
    }

    if (msg.msg_type === "tick" && msg.tick) {
      addTick(
        msg.tick.symbol,
        Number(msg.tick.quote),
        Number(msg.tick.epoch)
      );
    }
  });

  socket.on("error", err => {
    errors = err.message;
    console.error("Market connection:", err.message);
  });

  socket.on("close", () => {
    connected = false;
    reconnectTimer = setTimeout(connect, 3000);
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mini App server listening on ${PORT}`);
  connect();
});
