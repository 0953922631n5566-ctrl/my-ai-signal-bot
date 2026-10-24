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
  evaluationMs: 500,
  maxDataAgeMs: 15_000
};

// ตั้งค่าคู่เงินพร้อม Venue และ Symbol สำหรับดึงจาก otcharts.com
const symbols = [
  { key: 'eurusd', venue: 'iqoption', symbol: 'EURUSD-OTC', name: 'EUR/USD (OTC)' },
  { key: 'gbpusdt', venue: 'iqoption', symbol: 'GBPUSD-OTC', name: 'GBP/USD (OTC)' },
  { key: 'usdjpy', venue: 'iqoption', symbol: 'USDJPY-OTC', name: 'USD/JPY (OTC)' },
  { key: 'audusd', venue: 'iqoption', symbol: 'AUDUSD-OTC', name: 'AUD/USD (OTC)' },
  { key: 'nzdusd', venue: 'iqoption', symbol: 'NZDUSD-OTC', name: 'NZD/USD (OTC)' },
  { key: 'usdcad', venue: 'iqoption', symbol: 'USDCAD-OTC', name: 'USD/CAD (OTC)' },
  { key: 'eurjpy', venue: 'iqoption', symbol: 'EURJPY-OTC', name: 'EUR/JPY (OTC)' },
  { key: 'gbpjpy', venue: 'iqoption', symbol: 'GBPJPY-OTC', name: 'GBP/JPY (OTC)' },
  { key: 'eurgbp', venue: 'iqoption', symbol: 'EURGBP-OTC', name: 'EUR/GBP (OTC)' },
  { key: 'audjpy', venue: 'iqoption', symbol: 'AUDJPY-OTC', name: 'AUD/JPY (OTC)' }
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
      lastSignalPrice: null,
      lastSignalBar: null
    }
  ])
);

// ฟังก์ชันรับราคาจริงเข้าสู่ระบบ
function updatePrice(key, price, timestamp = Date.now()) {
  if (!marketHistories[key]) return false;
  if (!Number.isFinite(price) || price <= 0) return false;

  const history = marketHistories[key];
  const last = history[history.length - 1];

  if (last && timestamp <= last.timestamp) {
    return false;
  }

  history.push({ price, timestamp });

  if (history.length > CONFIG.historyLimit) {
    history.splice(0, history.length - CONFIG.historyLimit);
  }

  return true;
}

function getPrices(history) {
  return history.map(item => item.price);
}

// --- ส่วนเชื่อมต่อ API ภายนอก (otcharts.com) ---
const OTCHARTS_BASE = 'https://otcharts.com';
const OTCHARTS_KEY = process.env.OTCHARTS_API_KEY;

async function fetchInitialCandles(s) {
  if (!OTCHARTS_KEY) {
    console.warn('[API Warning] Missing OTCHARTS_API_KEY environment variable.');
    return;
  }

  try {
    const params = new URLSearchParams({
      venue: s.venue,
      symbol: s.symbol,
      tf: '60',
      limit: '300'
    });

    const response = await fetch(`${OTCHARTS_BASE}/v1/candles?${params}`, {
      headers: { Authorization: `Bearer ${OTCHARTS_KEY}` },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) throw new Error(`HTTP error ${response.status}`);

    const result = await response.json();
    if (Array.isArray(result.candles)) {
      result.candles.forEach(c => {
        updatePrice(s.key, Number(c.close), Number(c.time) * 1000);
      });
      console.log(`[API Success] Loaded historical candles for ${s.name}: ${marketHistories[s.key].length} bars`);
    }
  } catch (err) {
    console.error(`[API Error] Failed to load history for ${s.name}:`, err.message);
  }
}

async function startStream(s) {
  if (!OTCHARTS_KEY) return;

  try {
    const params = new URLSearchParams({ venue: s.venue, symbol: s.symbol });
    const response = await fetch(`${OTCHARTS_BASE}/v1/stream?${params}`, {
      headers: { Authorization: `Bearer ${OTCHARTS_KEY}` },
      signal: AbortSignal.timeout(24 * 60 * 60 * 1000)
    });

    if (!response.ok || !response.body) {
      throw new Error(`Stream HTTP error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (eventName === 'tick' && Number.isFinite(Number(data.price))) {
              updatePrice(s.key, Number(data.price), Number(data.time) * 1000);
            }
          } catch (e) {
            // ignore parse error
          }
          eventName = '';
        }
      }
    }
  } catch (err) {
    console.warn(`[Stream Warning] Stream disconnected for ${s.name}, retrying in 5s...`);
    setTimeout(() => startStream(s), 5000);
  }
}

// เริ่มต้นดึงข้อมูลประวัติและเปิดสตรีมจริงทันทีเมื่อรันเซิร์ฟเวอร์
symbols.forEach(s => {
  fetchInitialCandles(s).then(() => {
    startStream(s);
  });
});
// ------------------------------------------------

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
    statusText: 'WAITING FOR LIVE DATA',
    signal: 'WAIT',
    confidence: '0.0',
    rsi: 50,
    trend: 'NEUTRAL',
    isVip: false
  };

  if (history.length < CONFIG.minHistory) {
    return base;
  }

  const last = history[history.length - 1];
  if (now - last.timestamp > CONFIG.maxDataAgeMs) {
    return { ...base, statusText: 'STALE DATA' };
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

  const returns = [];
  for (let i = Math.max(1, prices.length - 20); i < prices.length; i++) {
    if (prices[i - 1] !== 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }

  const volatility = returns.length
    ? Math.sqrt(returns.reduce((sum, r) => sum + r * r, 0) / returns.length) * 100
    : 0;

  if (bb.bandwidth < 0.015 || volatility < 0.001) {
    return {
      ...base,
      statusText: 'LOW VOLATILITY',
      rsi: Number(rsi.toFixed(1)),
      trend: trend.direction
    };
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
  console.log(`Live Real-Feed Signal Engine running on port ${PORT}`);
});

function shutdown() {
  clearInterval(broadcastTimer);
  wss.close(() => {
    server.close(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
