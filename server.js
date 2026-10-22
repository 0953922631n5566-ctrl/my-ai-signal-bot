const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let priceHistory = [];
let currentSymbol = 'EURUSDT';
let lockedSignal = 'WAIT';
let lockedConfidence = '0.0';
let binanceWS = null;

function connectBinanceStream(symbol = 'eurusdt') {
  if (binanceWS) {
    try { binanceWS.close(); } catch(e){}
  }

  const streamName = `${symbol.toLowerCase()}@ticker`;
  binanceWS = new WebSocket(`wss://stream.binance.com:9443/ws/${streamName}`);

  binanceWS.on('message', (data) => {
    try {
      const parsed = JSON.parse(data);
      const price = parseFloat(parsed.c);
      if (!isNaN(price)) {
        priceHistory.push(price);
        if (priceHistory.length > 120) priceHistory.shift();
      }
    } catch (e) {
      console.error("Binance Stream Error:", e);
    }
  });

  binanceWS.on('error', () => setTimeout(() => connectBinanceStream(symbol), 3000));
  binanceWS.on('close', () => setTimeout(() => connectBinanceStream(symbol), 3000));
}

connectBinanceStream('eurusdt');

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
    return { upper: p, middle: p, lower: p };
  }
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: sma + (mult * stdDev),
    middle: sma,
    lower: sma - (mult * stdDev)
  };
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

function processTradingEngine() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  if (priceHistory.length < 20) {
    const base = 1.0850;
    priceHistory.push(base + (Math.random() - 0.5) * 0.002);
  }

  const currentPrice = priceHistory[priceHistory.length - 1];
  const rsi = parseFloat(calculateRSI(priceHistory).toFixed(1));
  const ema50 = calculateEMA(priceHistory, 50);
  const bb = calculateBB(priceHistory);
  
  const isUpTrend = currentPrice > ema50;
  const isDownTrend = currentPrice < ema50;

  // 🎯 ประมวลผลและล็อกสัญญาณในช่วง 5 วินาทีสุดท้ายก่อนหมดแท่ง
  if (exactTimeLeft <= 5.0 && exactTimeLeft > 0.5) {
    let scoreCALL = 0;
    let scorePUT = 0;

    if (rsi <= 40) scoreCALL += 35;
    else if (rsi >= 60) scorePUT += 35;

    if (currentPrice <= bb.lower) scoreCALL += 35;
    else if (currentPrice >= bb.upper) scorePUT += 35;

    if (isUpTrend) scoreCALL += 25;
    if (isDownTrend) scorePUT += 25;

    const prevPrice = priceHistory[priceHistory.length - 3] || currentPrice;
    if (currentPrice > prevPrice) scoreCALL += 15;
    else if (currentPrice < prevPrice) scorePUT += 15;

    if (scoreCALL >= 55 && scoreCALL > scorePUT) {
      lockedSignal = 'CALL';
      lockedConfidence = Math.min(scoreCALL, 94.0).toFixed(1);
    } else if (scorePUT >= 55 && scorePUT > scoreCALL) {
      lockedSignal = 'PUT';
      lockedConfidence = Math.min(scorePUT, 94.0).toFixed(1);
    } else {
      lockedSignal = 'WAIT';
      lockedConfidence = '0.0';
    }
  }

  // ⏳ ให้สัญญาณ CALL / PUT ค้างไว้ 30 วินาทีในแท่งใหม่ แล้วค่อยรีเซ็ตกลับเป็น WAIT
  if (exactTimeLeft <= 30.0 && exactTimeLeft > 28.5 && lockedSignal !== 'WAIT') {
    lockedSignal = 'WAIT';
    lockedConfidence = '0.0';
  }

  return {
    type: 'market_update',
    signal: lockedSignal,
    confidence: lockedConfidence,
    rsi: rsi,
    trend: isUpTrend ? 'BULLISH 🟢' : 'BEARISH 🔴',
    price: currentPrice.toFixed(5),
    timeLeft: displayTimeLeft
  };
}

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe') {
        let sym = 'eurusdt';
        if (data.symbol === 'GBPUSD') sym = 'gbpusdt';
        if (data.symbol === 'USDJPY') sym = 'usdtjpy';
        if (data.symbol === 'BTCUSD') sym = 'btcusdt';
        if (data.symbol === 'AUDUSD') sym = 'audusdt';
        
        if (sym !== currentSymbol) {
          currentSymbol = sym;
          priceHistory = [];
          connectBinanceStream(sym);
        }
      }
    } catch(e){}
  });
});

setInterval(() => {
  const data = processTradingEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Engine running on port ${PORT}`));
