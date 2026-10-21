const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let currentPrice = 1.0850;

function generateMarketData() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  
  // คำนวณเวลาที่เหลือเป็นทศนิยม (เช่น 1.5 วินาที)
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  const change = (Math.random() - 0.49) * 0.0002;
  currentPrice = parseFloat((currentPrice + change).toFixed(5));

  const rsi = parseFloat((40 + Math.random() * 20 + (change > 0 ? 10 : -10)).toFixed(1));

  let signal = 'WAIT';
  let confidence = '0.0';

  // ล็อกส่งสัญญาณสรุปเด็ดขาดในช่วง <= 1.5 วินาทีสุดท้าย
  if (exactTimeLeft <= 1.5 && exactTimeLeft > 0) { 
    if (rsi < 42) {
      signal = 'CALL';
      confidence = (84 + Math.random() * 10).toFixed(1);
    } else if (rsi > 58) {
      signal = 'PUT';
      confidence = (84 + Math.random() * 10).toFixed(1);
    }
  }

  return {
    type: 'market_update',
    signal,
    confidence,
    rsi,
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
}, 500); // อัปเดตข้อมูลถี่ขึ้นทุกๆ 0.5 วินาทีเพื่อความแม่นยำ

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
