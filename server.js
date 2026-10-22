const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let currentSymbol = 'EURUSD';
let currentTF = '1m';

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe') {
        currentSymbol = data.symbol;
        currentTF = data.tf;
      }
    } catch (e) {}
  });
});

setInterval(() => {
  const now = new Date();
  const seconds = now.getSeconds();
  const timeLeft = 60 - seconds;
  
  let signal = 'WAIT';
  let confidence = 50.0;
  let rsi = (35 + Math.random() * 30).toFixed(1);

  if (rsi < 35) { signal = 'CALL'; confidence = 85.5; }
  else if (rsi > 65) { signal = 'PUT'; confidence = 87.2; }

  const payload = JSON.stringify({
    type: 'market_update',
    symbol: currentSymbol,
    tf: currentTF,
    signal,
    confidence,
    rsi,
    timeLeft
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
