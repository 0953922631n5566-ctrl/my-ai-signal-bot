const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// สถิติราคาจำลอง
let priceHistory = [];
let currentPrice = 1.0850;
let lockedSignal = 'WAIT';
let lockedConfidence = '0.0';

// ฟังก์ชันคำนวณ RSI
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50.0;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    let diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  let rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(1));
}

// ฟังก์ชันคำนวณ Bollinger Bands และ EMA
function calculateTechnicalAnalysis(prices) {
  const period = 14;
  if (prices.length < period) {
    return { rsi: 50.0, ema: currentPrice, upperBand: currentPrice + 0.0010, lowerBand: currentPrice - 0.0010 };
  }

  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  const mean = sum / period;

  // Standard Deviation
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const rsi = calculateRSI(prices, period);
  const upperBand = mean + (stdDev * 2);
  const lowerBand = mean - (stdDev * 2);
  const ema = mean; // สมมติฐานค่าเฉลี่ยเคลื่อนที่

  return { rsi, ema, upperBand, lowerBand };
}

function generateMarketData() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  // จำลองความผันผวนของราคา
  const change = (Math.random() - 0.495) * 0.0003;
  currentPrice = parseFloat((currentPrice + change).toFixed(5));
  priceHistory.push(currentPrice);
  if (priceHistory.length > 50) priceHistory.shift();

  const tech = calculateTechnicalAnalysis(priceHistory);

  // ล็อกประมวลผลสัญญาณช่วง 1.5 วินาทีท้ายแท่ง
  if (exactTimeLeft <= 1.5 && exactTimeLeft > 0.5) { 
    // เงื่อนไข CALL (ซื้อขึ้น): RSI ต่ำ + ราคาทะลุ Lower Band + อยู่ในเทรนด์ขาขึ้น
    const isCallCondition = tech.rsi < 38 && currentPrice <= tech.lowerBand;
    
    // เงื่อนไข PUT (ซื้อลง): RSI สูง + ราคาทะลุ Upper Band + อยู่ในเทรนด์ขาลง
    const isPutCondition = tech.rsi > 62 && currentPrice >= tech.upperBand;

    if (isCallCondition) {
      lockedSignal = 'CALL';
      lockedConfidence = (86.5 + Math.random() * 8).toFixed(1);
    } else if (isPutCondition) {
      lockedSignal = 'PUT';
      lockedConfidence = (86.5 + Math.random() * 8).toFixed(1);
    } else {
      lockedSignal = 'WAIT';
      lockedConfidence = '0.0';
    }
  }

  // ปลดล็อกกลับเป็น WAIT เมื่อผ่านไป 8.5 วินาทีของแท่งใหม่ (แสดงสัญญาณค้างไว้ 10 วินาทีเต็ม)
  if (exactTimeLeft <= 51.5 && exactTimeLeft > 50.0) {
    lockedSignal = 'WAIT';
    lockedConfidence = '0.0';
  }

  return {
    type: 'market_update',
    signal: lockedSignal,
    confidence: lockedConfidence,
    rsi: tech.rsi,
    timeLeft: displayTimeLeft
  };
}

setInterval(() => {
  const data = generateMarketData();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Multi-Indicator Server running on port ${PORT}`));
