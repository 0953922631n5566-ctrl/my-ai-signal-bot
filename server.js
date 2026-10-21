const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let currentPrice = 1.0850;
let lockedSignal = 'WAIT';
let lockedConfidence = '0.0';

function generateMarketData() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  const change = (Math.random() - 0.49) * 0.0002;
  currentPrice = parseFloat((currentPrice + change).toFixed(5));

  const rsi = parseFloat((40 + Math.random() * 20 + (change > 0 ? 10 : -10)).toFixed(1));

  // ล็อกสัญญาณตอน 1.5 วินาทีท้ายแท่ง
  if (exactTimeLeft <= 1.5 && exactTimeLeft > 0.5) { 
    if (rsi < 42) {
      lockedSignal = 'CALL';
      lockedConfidence = (84 + Math.random() * 10).toFixed(1);
    } else if (rsi > 58) {
      lockedSignal = 'PUT';
      lockedConfidence = (84 + Math.random() * 10).toFixed(1);
    } else {
      lockedSignal = 'WAIT';
      lockedConfidence = '0.0';
    }
  }

  // เคลียร์กลับเป็น WAIT หลังจากเข้าแท่งใหม่ไปแล้ว 8.5 วินาที (รวมค้างไว้ 10 วินาทีพอดี)
  if (exactTimeLeft <= 51.5 && exactTimeLeft > 50.0) {
    lockedSignal = 'WAIT';
    lockedConfidence = '0.0';
  }

  return {
    type: 'market_update',
    signal: lockedSignal,
    confidence: lockedConfidence,
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
}, 500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
