const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

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
symbols.forEach(s => marketHistories[s.key] = []);

function connectAllStreams() {
  symbols.forEach(s => {
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${s.key}@ticker`);
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data);
        const price = parseFloat(parsed.c);
        if (!isNaN(price)) {
          marketHistories[s.key].push(price);
          if (marketHistories[s.key].length > 120) marketHistories[s.key].shift();
        }
      } catch (e) {}
    });
    ws.on('error', () => setTimeout(connectAllStreams, 3000));
    ws.on('close', () => setTimeout(connectAllStreams, 3000));
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

function processEngine() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let pairStatuses = [];

  symbols.forEach(s => {
    const prices = marketHistories[s.key];
    if (!prices || prices.length < 20) {
      pairStatuses.push({
        key: s.key,
        name: s.name,
        statusColor: 'green',
        statusText: 'SAFE',
        signal: 'WAIT',
        confidence: '50.0',
        rsi: 50.0,
        trend: 'READY 🟢'
      });
      return;
    }

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2] || currentPrice;
    const rsi = parseFloat(calculateRSI(prices).toFixed(1));
    
    const ema5 = calculateEMA(prices, 5);
    const ema20 = calculateEMA(prices, 20);
    const bb = calculateBB(prices);

    // เงื่อนไขเทรนด์ตามน้ำ (Trend Following)
    const isBullishTrend = ema5 > ema20 && currentPrice >= ema5;
    const isBearishTrend = ema5 < ema20 && currentPrice <= ema5;
    const isSideway = bb.bandwidth < 0.1;

    let statusColor = 'green';
    let statusText = 'SAFE';
    let signal = 'WAIT';
    let confidence = '50.0';

    if (isSideway) {
      statusColor = 'red';
      statusText = 'DANGER';
      signal = 'SIDEWAY';
    } else {
      let score = 60;
      if (isBullishTrend || isBearishTrend) score += 25;
      if (currentPrice !== prevPrice) score += 10;
      
      confidence = Math.min(score, 95.0).toFixed(1);

      // ส่งสัญญาณในช่วง 0.5 ถึง 0.0 วินาทีสุดท้าย
      if (exactTimeLeft <= 0.5 && exactTimeLeft >= 0.0) {
        if (isBullishTrend && score >= 65) signal = 'CALL';
        else if (isBearishTrend && score >= 65) signal = 'PUT';
      }
    }

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: statusColor,
      statusText: statusText,
      signal: signal,
      confidence: confidence,
      rsi: rsi,
      trend: isBullishTrend ? 'BULLISH 🟢' : (isBearishTrend ? 'BEARISH 🔴' : 'NEUTRAL ⚪')
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
