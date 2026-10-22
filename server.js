const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// จำลองฐานข้อมูลราคา (Price History) สำหรับคำนวณ Indicator
let priceHistory = Array.from({ length: 50 }, () => 1.0850 + (Math.random() - 0.5) * 0.0050);
let lockedSignal = 'WAIT';
let lockedConfidence = '0.0';

// ฟังก์ชันคำนวณ EMA (Moving Average)
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// ฟังก์ชันคำนวณ Bollinger Bands
function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: sma + multiplier * stdDev,
    middle: sma,
    lower: sma - multiplier * stdDev
  };
}

// ฟังก์ชันคำนวณ RSI
function calculateRSI(prices, period = 14) {
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

  // จำลองความเคลื่อนไหวราคา Real-time
  const lastPrice = priceHistory[priceHistory.length - 1];
  const change = (Math.random() - 0.49) * 0.0003;
  const newPrice = parseFloat((lastPrice + change).toFixed(5));
  
  priceHistory.push(newPrice);
  if (priceHistory.length > 100) priceHistory.shift();

  // คำนวณค่า Technical Indicators
  const rsi = parseFloat(calculateRSI(priceHistory).toFixed(1));
  const ema50 = calculateEMA(priceHistory, 50);
  const bb = calculateBollingerBands(priceHistory);
  
  const isUpTrend = newPrice > ema50;
  const isDownTrend = newPrice < ema50;

  // 🎯 ล็อกสัญญาณประมวลผลช่วง 1.5 วินาทีท้ายแท่ง
  if (exactTimeLeft <= 1.5 && exactTimeLeft > 0.5) {
    let scoreCALL = 0;
    let scorePUT = 0;

    // เงื่อนไข CALL (ซื้อขึ้น)
    if (rsi < 38) scoreCALL += 35; // RSI oversold
    if (newPrice <= bb.lower) scoreCALL += 35; // ราคาชนกรอบล่าง Bollinger
    if (isUpTrend) scoreCALL += 30; // แนวโน้มใหญ่เป็นเทรนด์ขึ้น

    // เงื่อนไข PUT (ซื้อลง)
    if (rsi > 62) scorePUT += 35; // RSI overbought
    if (newPrice >= bb.upper) scorePUT += 35; // ราคาชนกรอบบน Bollinger
    if (isDownTrend) scorePUT += 30; // แนวโน้มใหญ่เป็นเทรนด์ลง

    // กรองสัญญาณที่ความมั่นใจ 70% ขึ้นไปเท่านั้น
    if (scoreCALL >= 70 && scoreCALL > scorePUT) {
      lockedSignal = 'CALL';
      lockedConfidence = (scoreCALL + Math.random() * 5).toFixed(1);
    } else if (scorePUT >= 70 && scorePUT > scoreCALL) {
      lockedSignal = 'PUT';
      lockedConfidence = (scorePUT + Math.random() * 5).toFixed(1);
    } else {
      lockedSignal = 'WAIT';
      lockedConfidence = '0.0';
    }
  }

  // ⏳ ล็อกแสดงสัญญาณค้างไว้ 10 วินาที แล้วรีเซ็ตกลับเป็น WAIT
  if (exactTimeLeft <= 50.0 && exactTimeLeft > 48.5) {
    lockedSignal = 'WAIT';
    lockedConfidence = '0.0';
  }

  return {
    type: 'market_update',
    signal: lockedSignal,
    confidence: lockedConfidence,
    rsi: rsi,
    trend: isUpTrend ? 'BULLISH 🟢' : 'BEARISH 🔴',
    price: newPrice.toFixed(5),
    timeLeft: displayTimeLeft
  };
}

setInterval(() => {
  const data = processTradingEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PRO Trading Server running on port ${PORT}`));
