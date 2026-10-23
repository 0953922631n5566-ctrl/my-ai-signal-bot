const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const symbols = [
  { key: 'eurusd', name: 'EUR/USD', base: 1.0850 },
  { key: 'gbpusdt', name: 'GBP/USD', base: 1.3400 },
  { key: 'usdjpy', name: 'USD/JPY', base: 155.00 },
  { key: 'audusd', name: 'AUD/USD', base: 0.6550 },
  { key: 'nzdusd', name: 'NZD/USD', base: 0.6050 },
  { key: 'usdcad', name: 'USD/CAD', base: 1.3550 },
  { key: 'eurjpy', name: 'EUR/JPY', base: 167.50 },
  { key: 'gbpjpy', name: 'GBP/JPY', base: 197.50 },
  { key: 'eurgbp', name: 'EUR/GBP', base: 0.8520 },
  { key: 'audjpy', name: 'AUD/JPY', base: 101.50 }
];

let marketHistories = {};
let symbolSignalStates = {}; 

symbols.forEach(s => {
  marketHistories[s.key] = [];
  symbolSignalStates[s.key] = { signal: 'WAIT', timer: 0, confidence: '50.0', isVip: false };
  
  let p = s.base;
  for (let i = 0; i < 40; i++) {
    p += (Math.random() - 0.49) * (p * 0.0003);
    marketHistories[s.key].push(parseFloat(p.toFixed(5)));
  }
});

setInterval(() => {
  symbols.forEach(s => {
    const hist = marketHistories[s.key];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      const change = (Math.random() - 0.49) * (last * 0.0004);
      const nextP = parseFloat((last + change).toFixed(5));
      hist.push(nextP);
      if (hist.length > 120) hist.shift();
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
        statusText: 'SAFE',
        signal: state.signal,
        confidence: '50.0',
        rsi: 50.0,
        trend: 'READY 🟢',
        isVip: false
      });
      return;
    }

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2] || currentPrice;
    const rsi = parseFloat(calculateRSI(prices).toFixed(1));
    
    // เปลี่ยนมาใช้ค่า EMA 6 และ EMA 21
    const ema6 = calculateEMA(prices, 6);
    const ema21 = calculateEMA(prices, 21);
    const bb = calculateBB(prices);

    const isBullishTrend = ema6 > ema21 && currentPrice >= ema6;
    const isBearishTrend = ema6 < ema21 && currentPrice <= ema6;
    const isSideway = bb.bandwidth < 0.04;

    // ตัวกรองป้องกัน Overextended และความยืดของราคา
    const isRsiOverboughtExtreme = rsi >= 72.0;
    const isRsiOversoldExtreme = rsi <= 28.0;
    const priceStretch = Math.abs(currentPrice - ema6) / currentPrice * 100;
    const isTooFarFromEma = priceStretch > 0.08;

    let calculatedScore = 50.0;
    if (!isSideway) {
      const emaDiff = Math.abs(ema6 - ema21) / currentPrice * 1000;
      const momentum = Math.abs(currentPrice - prevPrice) / currentPrice * 1000;

      calculatedScore = 60.0 + (emaDiff * 12.0) + (momentum * 8.0);

      if (isTooFarFromEma) {
        calculatedScore -= 15.0; 
      }

      calculatedScore = Math.min(Math.max(calculatedScore, 50.0), 96.0);
    }

    let statusColor = 'green';
    let statusText = 'SAFE';

    if (isSideway) {
      statusColor = 'red';
      statusText = 'DANGER';
      calculatedScore = 40.0;
    } else {
      // ยิงสัญญาณช่วง 3.0 วินาทีสุดท้ายด้วยชุด EMA 6/21 ที่นิ่งและชัวร์ขึ้น
      if (exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0 && state.signal === 'WAIT') {
        
        if (isBullishTrend && !isRsiOverboughtExtreme && calculatedScore >= 60.0) {
          state.signal = 'CALL';
          state.timer = 30.0;
          state.confidence = calculatedScore.toFixed(1);
          state.isVip = calculatedScore >= 88.0 && !isTooFarFromEma;
        } 
        else if (isBearishTrend && !isRsiOversoldExtreme && calculatedScore >= 60.0) {
          state.signal = 'PUT';
          state.timer = 30.0;
          state.confidence = calculatedScore.toFixed(1);
          state.isVip = calculatedScore >= 88.0 && !isTooFarFromEma;
        }
      }
    }

    let finalSignal = state.signal;
    if (isSideway) {
      finalSignal = 'SIDEWAY';
    }

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: statusColor,
      statusText: statusText,
      signal: finalSignal,
      confidence: state.signal !== 'WAIT' ? state.confidence : calculatedScore.toFixed(1),
      rsi: rsi,
      trend: isBullishTrend ? 'BULLISH 🟢' : (isBearishTrend ? 'BEARISH 🔴' : 'NEUTRAL ⚪'),
      isVip: state.isVip
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
