const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// รายชื่อคู่เงินตลาด OTC ครบ 10 คู่
const symbols = [
  { key: 'eurusd_otc', name: 'EUR/USD (OTC)', base: 1.0850 },
  { key: 'gbpusd_otc', name: 'GBP/USD (OTC)', base: 1.3400 },
  { key: 'usdjpy_otc', name: 'USD/JPY (OTC)', base: 155.00 },
  { key: 'audusd_otc', name: 'AUD/USD (OTC)', base: 0.6550 },
  { key: 'nzdusd_otc', name: 'NZD/USD (OTC)', base: 0.6050 },
  { key: 'usdcad_otc', name: 'USD/CAD (OTC)', base: 1.3550 },
  { key: 'eurjpy_otc', name: 'EUR/JPY (OTC)', base: 167.50 },
  { key: 'gbpjpy_otc', name: 'GBP/JPY (OTC)', base: 197.50 },
  { key: 'eurgbp_otc', name: 'EUR/GBP (OTC)', base: 0.8520 },
  { key: 'audjpy_otc', name: 'AUD/JPY (OTC)', base: 101.50 }
];

let marketHistories = {};
let symbolSignalStates = {}; 

symbols.forEach(s => {
  marketHistories[s.key] = [];
  symbolSignalStates[s.key] = { signal: 'WAIT', timer: 0, department: 'OTC AI READY', confidence: '50.0', note: 'ANALYZING 🟢' };
  let p = s.base;
  for (let i = 0; i < 40; i++) {
    p += (Math.random() - 0.49) * (p * 0.0003);
    marketHistories[s.key].push(parseFloat(p.toFixed(5)));
  }
});

setInterval(() => {
  symbols.forEach(s => {
    const hist = marketHistories[s.key];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      const change = (Math.random() - 0.492) * (last * 0.00045);
      hist.push(parseFloat((last + change).toFixed(5)));
      if (hist.length > 120) hist.shift();
    }
  });
}, 1000);

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

// 🤖 ระบบ Multi-Agent Routing Pipeline (เบื้องหลัง)
function routerDepartment(prices) {
  const current = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const diff = Math.abs(current - prev);
  
  if (diff < current * 0.00015) {
    return { dept: 'Sideway Department', code: 'SIDEWAY' };
  } else if (current > prev) {
    return { dept: 'Bullish Trend Department', code: 'BULL' };
  } else {
    return { dept: 'Bearish Trend Department', code: 'BEAR' };
  }
}

function sidewaySpecialist(prices) {
  const last = prices[prices.length - 1];
  const slice = prices.slice(-10);
  const max = Math.max(...slice);
  const min = Math.min(...slice);
  
  if (last >= max * 0.9995) return { signal: 'PUT', confidence: '88.5', note: 'ชนแนวต้านกรอบไซด์เวย์' };
  if (last <= min * 1.0005) return { signal: 'CALL', confidence: '88.5', note: 'ชนแนวรับกรอบไซด์เวย์' };
  return { signal: 'WAIT', confidence: '60.0', note: 'กำลังวิ่งอยู่กลางกรอบ' };
}

function trendAndTrapSpecialist(prices, trendType) {
  const current = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const prev2 = prices[prices.length - 3] || prev;
  
  const isTrap = (trendType === 'BULL' && current < prev && prev > prev2) || 
                 (trendType === 'BEAR' && current > prev && prev < prev2);

  if (isTrap) {
    return {
      signal: trendType === 'BULL' ? 'PUT' : 'CALL',
      confidence: '92.0',
      note: 'ตรวจพบ Trap สวนกลับทันที ⚠️'
    };
  }

  return {
    signal: trendType === 'BULL' ? 'CALL' : 'PUT',
    confidence: '84.0',
    note: 'วิ่งตามทิศทางเทรนด์ปกติ 🟢'
  };
}

function processMultiAgentEngine() {
  const now = new Date();
  const exactTimeLeft = parseFloat((60 - (now.getSeconds() + now.getMilliseconds() / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let pairStatuses = [];

  symbols.forEach(s => {
    const prices = marketHistories[s.key];
    let state = symbolSignalStates[s.key];

    // ตัวนับเวลาถอยหลังล็อกสัญญาณ
    if (state.timer > 0) {
      state.timer = Math.max(0, state.timer - 0.2);
      if (state.timer === 0) {
        state.signal = 'WAIT';
        state.department = 'OTC AI READY';
        state.note = 'ANALYZING 🟢';
      }
    }

    if (!prices || prices.length < 20) return;

    const rsiVal = parseFloat(calculateRSI(prices).toFixed(1));
    const route = routerDepartment(prices);
    let specialistResult = { signal: 'WAIT', confidence: '50.0', note: 'Analysing' };

    if (route.code === 'SIDEWAY') {
      specialistResult = sidewaySpecialist(prices);
    } else {
      specialistResult = trendAndTrapSpecialist(prices, route.code);
    }

    // ล็อกสัญญาณเฉพาะช่วง 3 วินาทีสุดท้าย และตอนที่สถานะยังเป็น WAIT เท่านั้น
    if (exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0 && state.signal === 'WAIT') {
      if (specialistResult.signal !== 'WAIT') {
        state.signal = specialistResult.signal;
        state.timer = 30.0; // ล็อกโชว์สัญญาณ 30 วินาที
        state.department = route.dept;
        state.confidence = specialistResult.confidence;
        state.note = specialistResult.note;
      }
    }

    // ถ้ายังไม่ถึง 3 วินาทีสุดท้าย ให้บังคับแสดงผลเป็น WAIT รอสแตนบาย
    let finalSig = state.signal;
    let statusText = state.signal !== 'WAIT' ? state.department : 'OTC AI READY (WAITING)';
    let noteText = state.signal !== 'WAIT' ? state.note : 'รอจังหวะเข้าทำ ⏳';
    let confVal = state.signal !== 'WAIT' ? state.confidence : '50.0';

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: route.code === 'SIDEWAY' ? 'orange' : 'green',
      statusText: statusText,
      signal: finalSig,
      confidence: confVal,
      rsi: rsiVal,
      trend: noteText,
      isVip: parseFloat(confVal) > 90.0
    });
  });

  return { type: 'scanner_update', timeLeft: displayTimeLeft, pairs: pairStatuses };
}

setInterval(() => {
  const data = processMultiAgentEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}, 200);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Multi-Agent OTC Engine running on port ${PORT}`));
