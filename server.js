
'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYMBOLS = [
  'EUR/USD OTC',
  'GBP/USD OTC',
  'USD/JPY OTC',
  'AUD/USD OTC',
  'EUR/GBP OTC',
  'USD/CHF OTC'
];

const CANDLE_MS = 60_000;
const SIGNAL_MS = 40_000;
const markets = new Map();

function randomNormal() {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Math.random();
  return (sum - 3) * 2;
}

function initialPrice(symbol) {
  return symbol.includes('JPY')
    ? 150 + Math.random() * 2
    : 1 + Math.random() * 0.3;
}

function createMarket(symbol) {
  if (markets.has(symbol)) return markets.get(symbol);

  const price = initialPrice(symbol);
  const now = Date.now();
  const candleStart = Math.floor(now / CANDLE_MS) * CANDLE_MS;

  const market = {
    symbol,
    price,
    candleStart,
    candles: [],
    signal: null,
    signalUntil: 0,
    history: [],
    wins: 0,
    losses: 0
  };

  let p = price;

  for (let i = 45; i >= 1; i--) {
    const open = p;
    p *= 1 + randomNormal() * 0.00008;

    market.candles.push({
      time: candleStart - i * CANDLE_MS,
      open,
      high: Math.max(open, p),
      low: Math.min(open, p),
      close: p
    });
  }

  market.price = p;
  market.candles.push({
    time: candleStart,
    open: p,
    high: p,
    low: p,
    close: p
  });

  markets.set(symbol, market);
  return market;
}

function updateMarket(market) {
  const now = Date.now();
  const currentStart = Math.floor(now / CANDLE_MS) * CANDLE_MS;

  if (currentStart !== market.candleStart) {
    market.candleStart = currentStart;

    market.candles.push({
      time: currentStart,
      open: market.price,
      high: market.price,
      low: market.price,
      close: market.price
    });

    if (market.candles.length > 240) {
      market.candles.shift();
    }
  }

  // ราคาสังเคราะห์ ไม่ใช่ราคาตลาด OTC จริง
  const volatility = market.symbol.includes('JPY')
    ? 0.00010
    : 0.00008;

  const drift = Math.sin(now / 45000) * volatility * 0.08;

  market.price = Math.max(
    0.0001,
    market.price * (1 + randomNormal() * volatility + drift)
  );

  const candle = market.candles[market.candles.length - 1];

  candle.high = Math.max(candle.high, market.price);
  candle.low = Math.min(candle.low, market.price);
  candle.close = market.price;
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function analyse(market) {
  const closes = market.candles.map(c => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, 14);

  const momentum = closes.length >= 5
    ? ((closes.at(-1) - closes.at(-5)) /
       closes.at(-5)) * 10000
    : 0;

  let score = 0;

  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21) score++;
    if (ema9 < ema21) score--;
  }

  if (momentum > 0.3) score++;
  if (momentum < -0.3) score--;

  if (rsi !== null) {
    if (rsi >= 52 && rsi < 70) score++;
    if (rsi <= 48 && rsi > 30) score--;
  }

  let signal = 'WAIT';

  if (score >= 2) signal = 'CALL';
  if (score <= -2) signal = 'PUT';

  return {
    signal,
    score,
    // เป็นคะแนนความสอดคล้อง ไม่ใช่โอกาสชนะจริง
    confidence: Math.min(85, 50 + Math.abs(score) * 10),
    indicators: {
      ema9,
      ema21,
      rsi,
      momentum
    }
  };
}

function snapshot(symbol) {
  const market = createMarket(symbol);
  const now = Date.now();
  const analysis = analyse(market);

  return {
    ok: true,
    mode: 'SIMULATION',
    disclaimer: 'SIMULATED PRICE - NOT LIVE OTC DATA',
    symbol: market.symbol,
    price: market.price,
    serverTime: now,
    candleStart: market.candleStart,
    candleRemaining: Math.max(
      0,
      Math.ceil(
        (market.candleStart + CANDLE_MS - now) / 1000
      )
    ),
    candles: market.candles.slice(-60),
    analysis,
    order: {
      active: now < market.signalUntil,
      signal: now < market.signalUntil ? market.signal : null,
      expiresAt: market.signalUntil
    },
    stats: {
      wins: market.wins,
      losses: market.losses,
      total: market.wins + market.losses
    },
    history: market.history.slice(-10).reverse()
  };
}

for (const symbol of SYMBOLS) createMarket(symbol);

setInterval(() => {
  for (const market of markets.values()) {
    updateMarket(market);
  }
}, 1000);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'OTC AI Signal Radar',
    mode: 'SIMULATION',
    time: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    connected: true,
    mode: 'SIMULATION_ONLY',
    symbols: SYMBOLS,
    timeframe: '1m',
    liveMarketData: false
  });
});

app.get('/api/snapshot', (req, res) => {
  const symbol = SYMBOLS.includes(req.query.symbol)
    ? req.query.symbol
    : SYMBOLS[0];

  res.json(snapshot(symbol));
});

app.get('/api/stream', (req, res) => {
  const symbol = SYMBOLS.includes(req.query.symbol)
    ? req.query.symbol
    : SYMBOLS[0];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = () => {
    res.write(`data: ${JSON.stringify(snapshot(symbol))}\n\n`);
  };

  send();

  const timer = setInterval(send, 1000);

  req.on('close', () => clearInterval(timer));
});

app.post('/api/signal', (req, res) => {
  const symbol = SYMBOLS.includes(req.body?.symbol)
    ? req.body.symbol
    : SYMBOLS[0];

  const market = createMarket(symbol);
  const now = Date.now();

  if (now < market.signalUntil) {
    return res.json({
      ok: true,
      accepted: false,
      reason: 'SIGNAL_ALREADY_ACTIVE',
      ...snapshot(symbol)
    });
  }

  const result = analyse(market);

  if (result.signal === 'WAIT') {
    return res.json({
      ok: true,
      accepted: false,
      reason: 'NO_CLEAR_SIGNAL',
      ...snapshot(symbol)
    });
  }

  market.signal = result.signal;
  market.signalUntil = now + SIGNAL_MS;

  market.history.push({
    time: now,
    symbol,
    signal: result.signal,
    score: result.score,
    outcome: 'PENDING'
  });

  if (market.history.length > 50) {
    market.history.shift();
  }

  res.json({
    ok: true,
    accepted: true,
    signal: result.signal,
    expiresAt: market.signalUntil,
    analysis: result,
    ...snapshot(symbol)
  });
});

// บันทึกผล Paper Trading ด้วยตนเอง
app.post('/api/outcome', (req, res) => {
  const symbol = SYMBOLS.includes(req.body?.symbol)
    ? req.body.symbol
    : SYMBOLS[0];

  const outcome = req.body?.outcome;

  if (!['WIN', 'LOSS'].includes(outcome)) {
    return res.status(400).json({
      ok: false,
      error: 'outcome must be WIN or LOSS'
    });
  }

  const market = createMarket(symbol);

  if (outcome === 'WIN') market.wins++;
  else market.losses++;

  res.json({
    ok: true,
    stats: {
      wins: market.wins,
      losses: market.losses,
      total: market.wins + market.losses
    }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OTC AI Radar listening on port ${PORT}`);
});
