const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const symbols = [
  { key: 'eurusd_otc', name: 'EUR/USD (OTC)', base: 1.0850 },
  { key: 'gbpusd_otc', name: 'GBP/USD (OTC)', base: 1.3400 }
];

let marketHistories = {};
let symbolSignalStates = {}; 

symbols.forEach(s => {
  marketHistories[s.key] = [];
  symbolSignalStates[s.key] = { signal: 'WAIT', timer: 0, department: 'Initializing', confidence: '50.0' };
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

// --- 🤖 จำลองระบบ AI หลายแผนกส่งต่อข้อมูล (Multi-Agent Pipeline) ---

// แผนกที่ 1: AI คัดแยกสภาพตลาด (Router Agent)
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

// แผนกที่ 2: AI ผู้เชี่ยวชาญฝั่งไซด์เวย์
function sidewaySpecialist(prices) {
  const last = prices[prices.length - 1];
  const slice = prices.slice(-10);
  const max = Math.max(...slice);
  const min = Math.min(...slice);
  
  if (last >= max * 0.9995) return { signal: 'PUT', confidence: '88.5', note: 'ชนแนวต้านกรอบไซด์เวย์' };
  if (last <= min * 1.0005) return { signal: 'CALL', confidence: '88.5', note: 'ชนแนวรับกรอบไซด์เวย์' };
  return { signal: 'WAIT', confidence: '60.0', note: 'กำลังวิ่งอยู่กลางกรอบ' };
}

// แผนกที่ 3: AI ผู้เชี่ยวชาญฝั่งเทรนด์และดักจับกับดัก (Trend & Trap Specialist)
function trendAndTrapSpecialist(prices, trendType) {
  const current = prices[prices.length - 1];
  const prev = prices[prices.length - 2];
  const prev2 = prices[prices.length - 3] || prev;
  
  // ตรวจสอบการสะบัดหลอก (Trap)
  const isTrap = (trendType === 'BULL' && current < prev && prev > prev2) || 
                 (trendType === 'BEAR' && current > prev && prev < prev2);

  if (isTrap) {
    // เจอของแปลก/โดนตบหลอก ส่งให้ผู้เชี่ยวชาญพลิกเกมสวนทางทันที
    return {
      signal: trendType === 'BULL' ? 'PUT' : 'CALL',
      confidence: '92.0',
      note: 'ตรวจพบ Trap สวนกลับทันที'
    };
  }

  return {
    signal: trendType === 'BULL' ? 'CALL' : 'PUT',
    confidence: '84.0',
    note: 'วิ่งตามทิศทางเทรนด์ปกติ'
  };
}

// ระบบประมวลผลหลักผ่านท่อส่งต่อ (Master Orchestrator)
function processMultiAgentEngine() {
  const now = new Date();
  const exactTimeLeft = parseFloat((60 - (now.getSeconds() + now.getMilliseconds() / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let pairStatuses = [];

  symbols.forEach(s => {
    const prices = marketHistories[s.key];
    let state = symbolSignalStates[s.key];

    if (state.timer > 0) {
      state.timer = Math.max(0, state.timer - 0.2);
      if (state.timer === 0) state.signal = 'WAIT';
    }

    if (!prices || prices.length < 20) return;

    // 1. หยิบกราฟไปถาม "แผนกคัดแยก" ก่อนว่าเป็นของใคร
    const route = routerDepartment(prices);
    let specialistResult = { signal: 'WAIT', confidence: '50.0', note: 'Analysing' };

    // 2. ส่งต่อให้แผนกเฉพาะทางตามป้ายกำกับ
    if (route.code === 'SIDEWAY') {
      specialistResult = sidewaySpecialist(prices);
    } else {
      specialistResult = trendAndTrapSpecialist(prices, route.code);
    }

    // 3. ช่วง 3 วินาทีสุดท้าย ล็อกผลลัพธ์จากผู้เชี่ยวชาญ
    if (exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0 && state.signal === 'WAIT' && specialistResult.signal !== 'WAIT') {
      state.signal = specialistResult.signal;
      state.timer = 30.0;
      state.department = route.dept;
    }

    let finalSig = state.signal !== 'WAIT' ? state.signal : specialistResult.signal;

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: route.code === 'SIDEWAY' ? 'orange' : 'green',
      statusText: route.dept,
      signal: finalSig,
      confidence: specialistResult.confidence,
      trend: specialistResult.note,
      isVip: parseFloat(specialistResult.confidence) > 90.0
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
