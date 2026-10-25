const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static("public"));
app.use(express.json());

const SYMBOLS = {
  frxEURUSD: { name: "EUR/USD", yahoo: "EURUSD=X" },
  frxGBPUSD: { name: "GBP/USD", yahoo: "GBPUSD=X" },
  frxUSDJPY: { name: "USD/JPY", yahoo: "USDJPY=X" },
  frxAUDUSD: { name: "AUD/USD", yahoo: "AUDUSD=X" },
  frxUSDCAD: { name: "USD/CAD", yahoo: "USDCAD=X" }
};

let connected = false;
let lastError = null;

let selectedSymbol = "frxEURUSD";
let duration = 60;
let threshold = 65;

const prices = {};
const lastTickBySymbol = {};
const candlesBySymbol = {};

for (const symbol of Object.keys(SYMBOLS)) {
  candlesBySymbol[symbol] = [];
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

function analyse(symbol) {
  const candles = candlesBySymbol[symbol] || [];
  const age = Date.now() - (lastTickBySymbol[symbol] || 0);

  if (!connected || age > 60000) {
    return {
      direction: "WAIT",
      score: 0,
      reason: "รอข้อมูลราคาสดหรือกำลังเชื่อมต่อใหม่"
    };
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

  let up = 0;
  let down = 0;
  const reasons = [];

  if (e6 > e21) {
    up += 2;
    reasons.push("EMA6 สูงกว่า EMA21");
  } else if (e6 < e21) {
    down += 2;
    reasons.push("EMA6 ต่ำกว่า EMA21");
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
    reason: reasons.join(" · ") || "รอสัญญาณที่ชัดเจน",
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

async function fetchMarketData(symbolKey) {
  const symbolInfo = SYMBOLS[symbolKey];
  if (!symbolInfo) return;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbolInfo.yahoo}?interval=1m&range=1d`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const data = await response.json();
    const result = data.chart?.result?.[0];
    if (!result) throw new Error("Invalid chart data");

    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const opens = quotes.open || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const closes = quotes.close || [];

    const newCandles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      newCandles.push({
        time: timestamps[i] * 1000,
        open: opens[i] ?? close,
        high: highs[i] ?? close,
        low: lows[i] ?? close,
        close: close
      });
    }

    if (newCandles.length > 0) {
      candlesBySymbol[symbolKey] = newCandles;
      const latest = newCandles[newCandles.length - 1];
      prices[symbolKey] = latest.close;
      lastTickBySymbol[symbolKey] = Date.now();
      connected = true;
      lastError = null;
    }
  } catch (err) {
    lastError = err.message;
    console.error(`Error fetching ${symbolKey}:`, err.message);
  }
}

async function updateAllMarkets() {
  for (const symbolKey of Object.keys(SYMBOLS)) {
    await fetchMarketData(symbolKey);
    await new Promise(r => setTimeout(r, 1000));
  }
}

updateAllMarkets();
setInterval(updateAllMarkets, 15000);

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    connected,
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    connected,
    fresh: connected && (Date.now() - (lastTickBySymbol[selectedSymbol] || 0) <= 60000),
    error: lastError,
    symbol: selectedSymbol,
    symbolName: SYMBOLS[selectedSymbol].name,
    duration,
    threshold,
    price: prices[selectedSymbol] ?? null,
    lastTick: lastTickBySymbol[selectedSymbol] || 0,
    ageMs: lastTickBySymbol[selectedSymbol] ? Date.now() - lastTickBySymbol[selectedSymbol] : null,
    candleCount: (candlesBySymbol[selectedSymbol] || []).length,
    source: "Yahoo Finance live reference feed",
    signal: analyse(selectedSymbol)
  });
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
  res.json({
    connected,
    fresh: connected && (Date.now() - (lastTickBySymbol[selectedSymbol] || 0) <= 60000),
    error: lastError,
    symbol: selectedSymbol,
    symbolName: SYMBOLS[selectedSymbol].name,
    duration,
    threshold,
    price: prices[selectedSymbol] ?? null,
    lastTick: lastTickBySymbol[selectedSymbol] || 0,
    ageMs: lastTickBySymbol[selectedSymbol] ? Date.now() - lastTickBySymbol[selectedSymbol] : null,
    candleCount: (candlesBySymbol[selectedSymbol] || []).length,
    source: "Yahoo Finance live reference feed",
    signal: analyse(selectedSymbol)
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Signal server listening on port ${PORT}`);
});
