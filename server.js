const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// จำลองการสร้างข้อมูลราคา Real-time & Indicator
let currentPrice = 1.0850;
let candles = [];

function generateMarketData() {
  const now = new Date();
  const seconds = now.getSeconds();
  const timeLeft = 60 - seconds; // เวลาที่เหลือของแท่ง 1 นาที

  // สุ่มการแกว่งของราคา
  const change = (Math.random() - 0.49) * 0.0002;
  currentPrice = parseFloat((currentPrice + change).toFixed(5));

  // สร้าง RSI จำลอง
  const rsi = parseFloat((40 + Math.random() * 20 + (change > 0 ? 10 : -10)).toFixed(1));

  // คำนวณสัญญาณ (สรุปสัญญาณเน้นๆ ในช่วง 3 วินาทีสุดท้ายก่อนปิดแท่ง)
  let signal = 'WAIT';
  let confidence = '0.0';

  if (timeLeft <= 3) { 
    if (rsi < 35) {
      signal = 'CALL';
      confidence = (85 + Math.random() * 10).toFixed(1);
    } else if (rsi > 65) {
      signal = 'PUT';
      confidence = (85 + Math.random() * 10).toFixed(1);
    }
  }

  const candle = {
    time: Math.floor(now.getTime() / 1000),
    open: currentPrice - change,
    high: currentPrice + 0.0001,
    low: currentPrice - 0.0001,
    close: currentPrice
  };

  return {
    type: 'market_update',
    candle,
    signal,
    confidence,
    rsi,
    timeLeft
  };
}

// ส่งข้อมูลหาผู้ใช้งานทุกๆ 1 วินาที
setInterval(() => {
  const data = generateMarketData();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
