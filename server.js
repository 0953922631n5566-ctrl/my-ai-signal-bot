const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// คลังคู่เงิน Forex หลักบน IQ Option
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
let signalStates1m = {}; 
let signalStates5m = {}; 

// ตั้งค่าข้อมูลเริ่มต้นแยกกันระหว่าง 1m และ 5m
symbols.forEach(s => {
  marketHistories[s.key] = [];
  signalStates1m[s.key] = { signal: 'WAIT', timer: 0 };
  signalStates5m[s.key] = { signal: 'WAIT', timer: 0 };
  
  let p = s.base;
  for (let i = 0; i < 60; i++) {
    p += (Math.random() - 0.49) * (p * 0.0003);
    marketHistories[s.key].push(parseFloat(p.toFixed(5)));
  }
});

// อัปเดตราคาตลาดทุก 1 วินาที
setInterval(() => {
  symbols.forEach(s => {
    const hist = marketHistories[s.key];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      const change = (Math.random() - 0.49) * (last * 0.0004);
      const nextP = parseFloat((last + change).toFixed(5));
      hist.push(nextP);
      if (hist.length > 180) hist.shift();
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

// ⚙️ ระบบประมวลผลสัญญาณ (รองรับทั้ง timeframe '1m' และ '5m')
function processEngine(tf = '1m') {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();

  // คำนวณเวลานับถอยหลังแยกตามกรอบเวลา
  let exactTimeLeft, displayTimeLeft, isEntryWindow, lockDuration;

  if (tf === '5m') {
    // คำนวณถอยหลังระดับแท่ง 5 นาที (300 วินาที)
    const secInBlock = (minutes % 5) * 60 + seconds + millis / 1000;
    exactTimeLeft = parseFloat((300 - secInBlock).toFixed(1));
    displayTimeLeft = Math.ceil(exactTimeLeft);
    isEntryWindow = exactTimeLeft <= 5.0 && exactTimeLeft >= 0.0; // ยิงช่วง 5 วินาทีสุดท้าย
    lockDuration = 60.0; // ล็อกไฟค้างไว้ 1 นาที
  } else {
    // คำนวณถอยหลังระดับแท่ง 1 นาที (60 วินาที)
    exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
    displayTimeLeft = Math.ceil(exactTimeLeft);
    isEntryWindow = exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0; // ยิงช่วง 3 วินาทีสุดท้าย
    lockDuration = 30.0; // ล็อกไฟค้างไว้ 30 วินาที
  }

  let pairStatuses = [];
  const stateDict = (tf === '5m') ? signalStates5m : signalStates1m;

  symbols.forEach(s => {
    const prices = marketHistories[s.key];
    let state = stateDict[s.key];
    let isNewSignal = false;

    // ลดเวลา ล็อกไฟ ตามรอบ
    if (state.timer > 0) {
      state.timer = Math.max(0, state.timer - 0.2);
      if (state.timer === 0) {
        state.signal = 'WAIT';
      }
    }

    if (!prices || prices.length < 20) {
      pairStatuses.push({
        key: s.key, name: s.name, statusColor: 'green', statusText: 'SAFE',
        signal: state.signal, confidence: '50.0', rsi: 50.0, trend: 'READY 🟢', isNewSignal: false
      });
      return;
    }

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2] || currentPrice;
    const rsi = parseFloat(calculateRSI(prices).toFixed(1));
    
    // ปรับตั้งค่า EMA/BB ตามกรอบเวลา
    const emaPeriodShort = tf === '5m' ? 8 : 5;
    const emaPeriodLong = tf === '5m' ? 25 : 20;

    const emaShort = calculateEMA(prices, emaPeriodShort);
    const emaLong = calculateEMA(prices, emaPeriodLong);
    const bb = calculateBB(prices);

    const isBullishTrend = emaShort > emaLong && currentPrice >= emaShort;
    const isBearishTrend = emaShort < emaLong && currentPrice <= emaShort;
    const isSideway = bb.bandwidth < 0.04;

    let statusColor = 'green';
    let statusText = 'SAFE';
    let confidence = '50.0';

    if (isSideway) {
      statusColor = 'red';
      statusText = 'DANGER';
    } else {
      let score = 65;
      if (isBullishTrend || isBearishTrend) score += 20;
      if (currentPrice !== prevPrice) score += 10;
      confidence = Math.min(score, 96.0).toFixed(1);

      // จังหวะออกสัญญาณ
      if (isEntryWindow && state.signal === 'WAIT') {
        if (isBullishTrend && score >= 58) {
          state.signal = 'CALL';
          state.timer = lockDuration;
          isNewSignal = true;
        } else if (isBearishTrend && score >= 58) {
          state.signal = 'PUT';
          state.timer = lockDuration;
          isNewSignal = true;
        }
      }
    }

    let finalSignal = state.signal;
    if (isSideway) finalSignal = 'SIDEWAY';

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: statusColor,
      statusText: statusText,
      signal: finalSignal,
      confidence: confidence,
      rsi: rsi,
      trend: isBullishTrend ? 'BULLISH 🟢' : (isBearishTrend ? 'BEARISH 🔴' : 'NEUTRAL ⚪'),
      isNewSignal: isNewSignal
    });
  });

  return {
    type: 'scanner_update',
    tf: tf,
    timeLeft: displayTimeLeft,
    pairs: pairStatuses
  };
}

// รับคำขอเลือกโหมด timeframe จากฝั่ง Frontend หน้าเว็บ
wss.on('connection', (ws) => {
  ws.selectedTF = '1m'; // ค่าเริ่มต้นคือ 1 นาที

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.action === 'change_tf' && (parsed.tf === '1m' || parsed.tf === '5m')) {
        ws.selectedTF = parsed.tf;
      }
    } catch (e) {}
  });
});

// ส่งข้อมูลแยกตามโหมดที่แต่ละ Client หน้าเว็บเลือกไว้
setInterval(() => {
  const data1m = processEngine('1m');
  const data5m = processEngine('5m');

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const payload = client.selectedTF === '5m' ? data5m : data1m;
      client.send(JSON.stringify(payload));
    }
  });
}, 200);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dual-Engine (1m/5m) running on port ${PORT}`));
