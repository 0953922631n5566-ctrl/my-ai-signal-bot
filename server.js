'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  maxPayload: 1024 * 16
});

app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  historyLimit: 500,
  minHistory: 60,
  emaFast: 6,
  emaSlow: 21,
  rsiPeriod: 14,
  bbPeriod: 20,
  minScore: 75,
  cooldownMs: 30_000,
  signalDurationMs: 30_000,
  evaluationMs: 500
};

const symbols = [
  { key: 'eurusd', name: 'EUR/USD (OTC)', basePrice: 1.0850 },
  { key: 'gbpusdt', name: 'GBP/USD (OTC)', basePrice: 1.2650 },
  { key: 'usdjpy', name: 'USD/JPY (OTC)', basePrice: 154.20 },
  { key: 'audusd', name: 'AUD/USD (OTC)', basePrice: 0.6550 },
  { key: 'nzdusd', name: 'NZD/USD (OTC)', basePrice: 0.5950 },
  { key: 'usdcad', name: 'USD/CAD (OTC)', basePrice: 1.3650 },
  { key: 'eurjpy', name: 'EUR/JPY (OTC)', basePrice: 167.30 },
  { key: 'gbpjpy', name: 'GBP/JPY (OTC)', basePrice: 195.10 },
  { key: 'eurgbp', name: 'EUR/GBP (OTC)', basePrice: 0.8570 },
  { key: 'audjpy', name: 'AUD/JPY (OTC)', basePrice: 101.00 }
];

const marketHistories = Object.fromEntries(
  symbols.map(s => [s.key, []])
);

const symbolSignalStates = Object.fromEntries(
  symbols.map(s => [
    s.key,
    {
      signal: 'WAIT',
      expiresAt: 0,
      lastSignalAt: 0,
      lastSignalPrice: null
    }
  ])
);

// ระบบสร้างราคาจำลองคุณภาพสูง (Quant Simulation Feed)
function generateSimulatedPrice(key, basePrice) {
  const history = marketHistories[key];
  const lastPrice = history.length > 0 ? history[history.length - 1].price : basePrice;
  
  // สุ่มความผันผวนจำลองให้สมจริง
  const changePercent = (Math.random() - 0.498) * 0.0008;
  const newPrice = Number((lastPrice * (1 + changePercent)).toFixed(5));
  
  history.push({ price: newPrice, timestamp: Date.now() });

  if (history.length > CONFIG.historyLimit) {
    history.splice(0, history.length - CONFIG.historyLimit);
  }
}

function getPrices(history) {
  return history.map(item => item.price);
}

function calculateEMA(prices, period) {
  if (!prices.length) return null;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateBB(prices, period = 20, mult = 2) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((sum, p) => sum + p, 0) / period;
  if (mean === 0) return null;
  const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + mult * sd,
    lower: mean - mult * sd,
    bandwidth: (4 * sd / mean) * 100
  };
}

function getTrend(prices) {
  const fast = calculateEMA(prices, CONFIG.emaFast);
  const slow = calculateEMA(prices, CONFIG.emaSlow);
  const current = prices[prices.length - 1];
  if (fast == null || slow == null || !current) {
    return { direction: 'NEUTRAL', strength: 0 };
  }
  return {
    direction: fast > slow ? 'BULLISH' : fast < slow ? 'BEARISH' : 'NEUTRAL',
    strength: Math.abs(fast - slow) / current * 100,
    fast,
    slow
  };
}

function analyzePair(symbol, now) {
  const history = marketHistories[symbol.key];
  const state = symbolSignalStates[symbol.key];

  const base = {
    key: symbol.key,
    name: symbol.name,
    statusColor: 'red',
    statusText: 'INITIALIZING',
    signal: 'WAIT',
    confidence: '0.0',
    rsi: 50,
    trend: 'NEUTRAL',
    isVip: false
  };

  if (history.length < CONFIG.minHistory) {
    return base;
  }

  const prices = getPrices(history);
  const current = prices[prices.length - 1];
  const previous = prices[prices.length - 2];

  const rsi = calculateRSI(prices, CONFIG.rsiPeriod);
  const trend = getTrend(prices);
  const bb = calculateBB(prices, CONFIG.bbPeriod);

  if (rsi == null || !bb || !Number.isFinite(current)) {
    return base;
  }

  const momentum = previous !== 0 ? (current - previous) / previous * 100 : 0;

  let callScore = 0;
  let putScore = 0;

  if (trend.direction === 'BULLISH') callScore += 35;
  if (trend.direction === 'BEARISH') putScore += 35;
  if (rsi >= 52 && rsi <= 68) callScore += 20;
  if (rsi <= 48 && rsi >= 32) putScore += 20;
  if (current > trend.fast) callScore += 15;
  if (current < trend.fast) putScore += 15;
  if (momentum > 0) callScore += 15;
  if (momentum < 0) putScore += 15;

  let candidate = 'WAIT';
  const topScore = Math.max(callScore, putScore);
  const scoreGap = Math.abs(callScore - putScore);

  if (callScore >= CONFIG.minScore && scoreGap >= 20) candidate = 'CALL';
  else if (putScore >= CONFIG.minScore && scoreGap >= 20) candidate = 'PUT';

  if (candidate === 'CALL' && rsi >= 70) candidate = 'WAIT';
  if (candidate === 'PUT' && rsi <= 30) candidate = 'WAIT';

  const inCooldown = now - state.lastSignalAt < CONFIG.cooldownMs;
  let signal = 'WAIT';
  let isVip = false;

  if (state.expiresAt > now) {
    signal = state.signal;
  } else {
    state.signal = 'WAIT';
    state.expiresAt = 0;

    if (!inCooldown && candidate !== 'WAIT') {
      state.signal = candidate;
      state.expiresAt = now + CONFIG.signalDurationMs;
      state.lastSignalAt = now;
      signal = candidate;
      isVip = true;
    }
  }

  return {
    ...base,
    statusColor: candidate === 'WAIT' ? 'red' : 'green',
    statusText: signal === 'WAIT' ? 'NO TRADE' : 'SIGNAL CONFIRMED',
    signal,
    confidence: String(Math.round(topScore)),
    rsi: Number(rsi.toFixed(1)),
    trend: trend.direction,
    isVip
  };
}

function processEngine() {
  const now = Date.now();
  // สร้างราคาใหม่ให้ทุกคู่เงิน
  symbols.forEach(s => generateSimulatedPrice(s.key, s.basePrice));
  
  const pairs = symbols.map(s => analyzePair(s, now));

  return {
    type: 'scanner_update',
    timeLeft: Math.ceil((60_000 - (now % 60_000)) / 1000),
    pairs
  };
}

const broadcastTimer = setInterval(() => {
  const data = JSON.stringify(processEngine());
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, err => {
        if (err) console.error('WebSocket send failed:', err.message);
      });
    }
  }
}, CONFIG.evaluationMs);

wss.on('connection', socket => {
  socket.send(JSON.stringify(processEngine()));
  socket.on('error', err => console.error('WebSocket error:', err.message));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Free Quant Signal Engine running on port ${PORT}`);
});

function shutdown() {
  clearInterval(broadcastTimer);
  wss.close(() => {
    server.close(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
