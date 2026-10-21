const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

let weights = {
  rsi: 0.35,
  emaCross: 0.40,
  bollinger: 0.25
};

function analyzeMarketData(candles) {
  const lastPrice = candles[candles.length - 1].close;
  const rsiValue = Math.floor(Math.random() * (75 - 25 + 1)) + 25;
  const emaFast = lastPrice;
  const emaSlow = lastPrice;

  let callScore = 0;
  let putScore = 0;

  if (rsiValue < 30) callScore += weights.rsi;
  if (rsiValue > 70) putScore += weights.rsi;

  let signal = 'WAIT';
  let totalScore = Math.max(callScore, putScore);
  let confidence = (totalScore * 100).toFixed(1);

  if (callScore > 0.30) signal = 'CALL 🟢';
  else if (putScore > 0.30) signal = 'PUT 🔴';

  return {
    signal,
    confidence,
    rsi: rsiValue.toFixed(1),
    price: lastPrice
  };
}

wss.on('connection', (ws) => {
  console.log('⚡ Mini App Client Connected');

  const interval = setInterval(() => {
    const mockCandles = [{ close: (1.12200 + Math.random() * 0.0005) }];
    const result = analyzeMarketData(mockCandles);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'MARKET_SIGNAL', data: result }));
    }
  }, 3000);

  ws.on('close', () => clearInterval(interval));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
