const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// รายการคู่เงินที่ระบบจะสแกนอัตโนมัติพร้อมกันหลังบ้าน
const symbols = [
  { key: 'eurusdt', name: 'EUR/USD' },
  { key: 'gbpusdt', name: 'GBP/USD' },
  { key: 'usdtjpy', name: 'USD/JPY' },
  { key: 'audusdt', name: 'AUD/USD' },
  { key: 'nzdusdt', name: 'NZD/USD' },
  { key: 'usdcad', name: 'USD/CAD' },
  { key: 'eurjpy', name: 'EUR/JPY' },
  { key: 'gbpjpy', name: 'GBP/JPY' }
];

let marketHistories = {};
let activeWebSockets = {};

symbols.forEach(s => {
  marketHistories[s.key] = [];
});

function connectAllStreams() {
  symbols.forEach(s => {
    const streamName = `${s.key}@ticker`;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${streamName}`);

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data);
        const price = parseFloat(parsed.c);
        if (!isNaN(price)) {
          marketHistories[s.key].push(price);
          if (marketHistories[s.key].length > 120) {
            marketHistories[s.key].shift();
          }
        }
      } catch (e) {}
    });

    ws.on('error', () => setTimeout(connectAllStreams, 3000));
    ws.on('close', () => setTimeout(connectAllStreams, 3000));
    activeWebSockets[s.key] = ws;
  });
}

connectAllStreams();

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
  if (prices.length < period) {
    const p = prices[prices.length - 1] || 0;
    return { bandwidth: 1 };
  }
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

let lockedBestSignal = {
  symbol: 'EUR/USD',
  signal: 'WAIT',
  confidence: '0.0',
  rsi: 50.0,
  trend: 'SCANNING... ⚡',
  timeLeft: 60
};

function processAutoScanner() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let bestCandidate = {
    symbol: 'AI AUTO SCANNER',
    signal: 'WAIT',
    confidence: '0.0',
    rsi: 50.0,
    trend: 'SEARCHING TREND 🔍',
    score: 0
  };

  // วิ่งสแกนหาคู่ที่ได้คะแนนสูงสุด (>80%) ในช่วง 0.5 วินาทีสุดท้าย
  if (exactTimeLeft <= 0.6 && exactTimeLeft > 0.1) {
    symbols.forEach(s => {
      const prices = marketHistories[s.key];
      if (prices && prices.length > 30) {
        const currentPrice = prices[prices.length - 1];
        const prevPrice = prices[prices.length - 2] || currentPrice;
        const rsi = parseFloat(calculateRSI(prices).toFixed(1));
        const ema50 = calculateEMA(prices, 50);
        const bb = calculateBB(prices);

        const isUpTrend = currentPrice > ema50;
        const isDownTrend = currentPrice < ema50;
        const isSideway = bb.bandwidth < 0.08 || (rsi >= 45 && rsi <= 55);

        if (!isSideway) {
          let scoreCALL = 0;
          let scorePUT = 0;

          if (isUpTrend) {
            scoreCALL += 45;
            if (rsi > 45 && rsi < 75) scoreCALL += 35;
            if (currentPrice > prevPrice) scoreCALL += 20;
          }

          if (isDownTrend) {
            scorePUT += 45;
            if (rsi < 55 && rsi > 25) scorePUT += 35;
            if (currentPrice < prevPrice) scorePUT += 20;
          }

          // คัดเลือกเฉพาะความมั่นใจ >= 80% ขึ้นไปเท่านั้น
          if (scoreCALL >= 80 && scoreCALL > scorePUT && scoreCALL > bestCandidate.score) {
            bestCandidate = {
              symbol: s.name,
              signal: 'CALL',
              confidence: Math.min(scoreCALL, 98.0).toFixed(1),
              rsi: rsi,
              trend: 'BULLISH 🟢',
              score: scoreCALL
            };
          } else if (scorePUT >= 80 && scorePUT > scoreCALL && scorePUT > bestCandidate.score) {
            bestCandidate = {
              symbol: s.name,
              signal: 'PUT',
              confidence: Math.min(scorePUT, 98.0).toFixed(1),
              rsi: rsi,
              trend: 'BEARISH 🔴',
              score: scorePUT
            };
          }
        }
      }
    });

    if (bestCandidate.signal !== 'WAIT') {
      lockedBestSignal = {
        symbol: bestCandidate.symbol,
        signal: bestCandidate.signal,
        confidence: bestCandidate.confidence,
        rsi: bestCandidate.rsi,
        trend: bestCandidate.trend,
        timeLeft: displayTimeLeft
      };
    }
  }

  // รีเซ็ตสถานะกลับเป็น WAIT เมื่อเข้าสู่ช่วงต้นแท่งใหม่ (30 วินาทีผ่านไป)
  if (exactTimeLeft <= 30.0 && exactTimeLeft > 28.5) {
    lockedBestSignal.signal = 'WAIT';
    lockedBestSignal.confidence = '0.0';
    lockedBestSignal.trend = 'AI AUTO SCANNER ACTIVE 🟢';
  }

  lockedBestSignal.timeLeft = displayTimeLeft;
  return { type: 'market_update', ...lockedBestSignal };
}

setInterval(() => {
  const data = processAutoScanner();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 200);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Auto Scanner Engine running on port ${PORT}`));
