const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// กำหนดคู่เงินตลาด OTC โดยเฉพาะสำหรับ IQ Option
const symbols = [
  { key: 'eurusd', name: 'EUR/USD (OTC)', base: 1.0850 },
  { key: 'gbpusdt', name: 'GBP/USD (OTC)', base: 1.3400 },
  { key: 'usdjpy', name: 'USD/JPY (OTC)', base: 155.00 },
  { key: 'audusd', name: 'AUD/USD (OTC)', base: 0.6550 },
  { key: 'nzdusd', name: 'NZD/USD (OTC)', base: 0.6050 },
  { key: 'usdcad', name: 'USD/CAD (OTC)', base: 1.3550 },
  { key: 'eurjpy', name: 'EUR/JPY (OTC)', base: 167.50 },
  { key: 'gbpjpy', name: 'GBP/JPY (OTC)', base: 197.50 },
  { key: 'eurgbp', name: 'EUR/GBP (OTC)', base: 0.8520 },
  { key: 'audjpy', name: 'AUD/JPY (OTC)', base: 101.50 }
];

let marketHistories = {};
let symbolSignalStates = {}; 

// ตั้งค่า AI สมองกล Machine Learning
const AI_CONFIG = {
  maxSamples: 5000,
  minSamples: 40, // จำนวนตัวอย่างขั้นต่ำเพื่อให้ AI เริ่มทำงานเร็วขึ้น
  neighbors: 50,
  minProbability: 0.58,
  minEdge: 0.10
};

const aiBrains = {};

symbols.forEach(s => {
  marketHistories[s.key] = [];
  symbolSignalStates[s.key] = { signal: 'WAIT', timer: 0, confidence: '50.0', isVip: false };
  
  aiBrains[s.key] = {
    samples: [],
    pending: null,
    evaluated: 0
  };

  let p = s.base;
  for (let i = 0; i < 40; i++) {
    p += (Math.random() - 0.49) * (p * 0.0003);
    marketHistories[s.key].push(parseFloat(p.toFixed(5)));
  }
});

// จำลองการขยับราคาตลาด OTC เรียลไทม์ + ส่งให้ AI เรียนรู้สดๆ
setInterval(() => {
  symbols.forEach(s => {
    const hist = marketHistories[s.key];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      const change = (Math.random() - 0.492) * (last * 0.00045);
      const nextP = parseFloat((last + change).toFixed(5));
      hist.push(nextP);
      if (hist.length > 120) hist.shift();

      // บันทึกและเรียนรู้ออนไลน์
      aiObserve(s.key, hist);
    }
  });
}, 1000);

function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateBB(prices, period = 20, mult = 2) {
  if (prices.length < period) return { bandwidth: 1 };
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = sma + (mult * stdDev);
  const lower = sma - (mult * stdDev);
  const bandwidth = ((upper - lower) / sma) * 100;
  return { bandwidth };
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50.0;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length - 1; i++) {
    const diff = prices[i + 1] - prices[i];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// 🧠 ฟังก์ชันสกัดฟีเจอร์และสมองกล AI
function aiFeatures(prices) {
  if (!prices || prices.length < 25) return null;
  const n = prices.length;
  const price = prices[n - 1];
  const prev = prices[n - 2];
  if (!price || !prev) return null;

  const e5 = calculateEMA(prices.slice(-30), 5);
  const e12 = calculateEMA(prices.slice(-30), 12);
  const e21 = calculateEMA(prices.slice(-30), 21);
  const r = calculateRSI(prices, 14);

  const momentum3 = (price - prices[n - 4]) / price * 10000;
  const momentum8 = (price - prices[n - 9]) / price * 10000;

  const volatilityPrices = prices.slice(-20);
  const mean = volatilityPrices.reduce((a, b) => a + b, 0) / volatilityPrices.length;
  const variance = volatilityPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / volatilityPrices.length;

  return [
    Math.max(-20, Math.min(20, (e5 - e12) / price * 10000)),
    Math.max(-20, Math.min(20, (e12 - e21) / price * 10000)),
    Math.max(-25, Math.min(25, (r - 50) / 2)),
    Math.max(-20, Math.min(20, momentum3)),
    Math.max(-30, Math.min(30, momentum8)),
    Math.max(0, Math.min(50, Math.sqrt(variance) / mean * 10000)),
    Math.max(-20, Math.min(20, (price - prev) / price * 10000))
  ];
}

function aiDistance(a, b) {
  const scales = [10, 10, 15, 10, 15, 20, 10];
  let total = 0;
  for (let i = 0; i < scales.length; i++) {
    const d = (a[i] - b[i]) / scales[i];
    total += d * d;
  }
  return total;
}

function aiObserve(symbolKey, prices) {
  const brain = aiBrains[symbolKey];
  if (!brain || prices.length < 25) return;
  const currentPrice = prices[prices.length - 1];

  if (brain.pending && currentPrice !== brain.pending.price) {
    const sample = {
      x: brain.pending.x,
      y: currentPrice > brain.pending.price ? 1 : 0
    };
    brain.samples.push(sample);
    if (brain.samples.length > AI_CONFIG.maxSamples) {
      brain.samples.shift();
    }
    brain.evaluated++;
    brain.pending = null;
  }

  if (!brain.pending) {
    const x = aiFeatures(prices);
    if (x) {
      brain.pending = { x, price: currentPrice };
    }
  }
}

function aiPredict(symbolKey, prices) {
  const brain = aiBrains[symbolKey];
  const x = aiFeatures(prices);

  if (!brain || !x || brain.samples.length < AI_CONFIG.minSamples) {
    return {
      signal: 'WAIT',
      upProbability: null,
      downProbability: null,
      samples: brain?.samples.length || 0
    };
  }

  const nearest = brain.samples
    .map(sample => ({
      y: sample.y,
      distance: aiDistance(x, sample.x)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, AI_CONFIG.neighbors);

  let up = 0;
  let down = 0;

  for (const item of nearest) {
    const weight = 1 / (0.05 + item.distance);
    if (item.y === 1) up += weight;
    else down += weight;
  }

  const total = up + down;
  if (!total) {
    return {
      signal: 'WAIT',
      upProbability: null,
      downProbability: null,
      samples: brain.samples.length
    };
  }

  const upProbability = up / total;
  const downProbability = down / total;
  const edge = Math.abs(upProbability - downProbability);

  let signal = 'WAIT';
  if (upProbability >= AI_CONFIG.minProbability && edge >= AI_CONFIG.minEdge) {
    signal = 'CALL';
  } else if (downProbability >= AI_CONFIG.minProbability && edge >= AI_CONFIG.minEdge) {
    signal = 'PUT';
  }

  return {
    signal,
    upProbability: Number((upProbability * 100).toFixed(1)),
    downProbability: Number((downProbability * 100).toFixed(1)),
    samples: brain.samples.length
  };
}

// 🧠 ระบบประมวลผลหลักผสาน AI และกฎความปลอดภัยตลาด OTC
function processEngine() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let pairStatuses = [];

  symbols.forEach(s => {
    const prices = marketHistories[s.key];
    let state = symbolSignalStates[s.key];

    if (state.timer > 0) {
      state.timer = Math.max(0, state.timer - 0.2);
      if (state.timer === 0) {
        state.signal = 'WAIT';
        state.isVip = false;
      }
    }

    if (!prices || prices.length < 25) {
      pairStatuses.push({
        key: s.key,
        name: s.name,
        statusColor: 'green',
        statusText: 'OTC AI READY',
        signal: state.signal,
        confidence: '50.0',
        rsi: 50.0,
        trend: 'ANALYZING 🟢',
        isVip: false
      });
      return;
    }

    const rsi = parseFloat(calculateRSI(prices).toFixed(1));
    const bb = calculateBB(prices);
    const isSideway = bb.bandwidth < 0.035;

    // เรียกใช้งานสมองกล AI ทำนายทิศทาง
    const aiRes = aiPredict(s.key, prices);

    let aiDecision = aiRes.signal;
    let aiConfidence = 50.0;
    let isVipSignal = false;
    let statusText = 'OTC SAFE';

    if (aiRes.upProbability !== null && aiRes.downProbability !== null) {
      aiConfidence = Math.max(aiRes.upProbability, aiRes.downProbability);
    }

    if (isSideway) {
      statusText = 'DANGER (OTC SIDEWAY)';
      aiDecision = 'SIDEWAY';
      aiConfidence = 40.0;
    } else {
      // ล็อกสัญญาณในช่วง 3 วินาทีสุดท้ายก่อนเปลี่ยนแท่งเทียน
      if (exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0 && state.signal === 'WAIT') {
        if (aiRes.signal !== 'WAIT') {
          state.signal = aiRes.signal;
          state.timer = 30.0;
          isVipSignal = aiConfidence >= 75.0;
        }
      }
    }

    let finalSignal = state.signal !== 'WAIT' ? state.signal : aiDecision;
    if (isSideway) finalSignal = 'SIDEWAY';

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: isSideway ? 'red' : 'green',
      statusText: statusText,
      signal: finalSignal,
      confidence: aiConfidence.toFixed(1),
      rsi: rsi,
      trend: finalSignal === 'CALL' ? 'BULLISH 🟢' : (finalSignal === 'PUT' ? 'BEARISH 🔴' : 'ANALYZING ⏳'),
      isVip: isVipSignal
    });
  });

  return {
    type: 'scanner_update',
    timeLeft: displayTimeLeft,
    pairs: pairStatuses
  };
}

setInterval(() => {
  const data = processEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 200);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`OTC Engine running on port ${PORT}`));
