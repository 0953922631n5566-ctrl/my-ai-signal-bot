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
  const timeLeft = 60 - seconds; 

  const change = (Math.random() - 0.49) * 0.0002;
  currentPrice = parseFloat((currentPrice + change).toFixed(5));

  const rsi = parseFloat((40 + Math.random() * 20 + (change > 0 ? 10 : -10)).toFixed(1));

  let signal = 'WAIT';
  let confidence = '0.0';

  // สรุปสัญญาณก่อนหมดแท่ง 3 วินาที
  if (timeLeft <= 3) { 
    if (rsi < 38) {
      signal = 'CALL';
      confidence = (82 + Math.random() * 12).toFixed(1);
    } else if (rsi > 62) {
      signal = 'PUT';
      confidence = (82 + Math.random() * 12).toFixed(1);
    }
  }

  const timestamp = Math.floor(now.getTime() / 1000);
  const candle = {
    time: timestamp - (timestamp % 60), // ล็อกเวลาตามนาที
    open: parseFloat((currentPrice - change).toFixed(5)),
    high: parseFloat((currentPrice + 0.0001).toFixed(5)),
    low: parseFloat((currentPrice - 0.0001).toFixed(5)),
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
