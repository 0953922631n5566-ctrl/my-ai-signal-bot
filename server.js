const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// กำหนดคู่เงินตลาด OTC โดยเฉพาะสำหรับ IQ Option
const symbols = [
  { key: 'eurusd', name: 'EUR/USD (OTC)', base: 1.0850 },
  { key: 'gbpusdt', name: 'GBP/USD (OTC)', base: 1.3400 },
  { key: 'usdjpy', name: 'USD/JPY (OTC)', base: 155.00 },
  { key: 'audusd', name: 'AUD/USD (OTC)', base: 0.6550 },
  { key: 'nzdusd', name: 'NZD/USD (OTC)', base: 0.6050 },
  { key: 'usdcad', name: 'USD/CAD (OTC)', base: 1.3550 },
  { key: 'eurjpy', name: 'EUR/JPY (OTC)', base: 167.50 },
  { key: 'gbpjpy', name: 'GBP/JPY (OTC)', base: 197.50 },
  { key: 'eurgbp', name: 'EUR/GBP (OTC)', base: 0.8520 },
  { key: 'audjpy', name: 'AUD/JPY (OTC)', base: 101.50 }
];

let marketHistories = {};
let symbolSignalStates = {}; 

symbols.forEach(s => {
  marketHistories[s.key] = [];
  symbolSignalStates[s.key] = { signal: 'WAIT', timer: 0, confidence: '50.0', isVip: false };
  
  let p = s.base;
  for (let i = 0; i < 40; i++) {
    p += (Math.random() - 0.49) * (p * 0.0003);
    marketHistories[s.key].push(parseFloat(p.toFixed(5)));
  }
});

// จำลองการขยับราคาตลาด OTC เรียลไทม์
setInterval(() => {
  symbols.forEach(s => {
    const hist = marketHistories[s.key];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      const change = (Math.random() - 0.492) * (last * 0.00045);
      const nextP = parseFloat((last + change).toFixed(5));
      hist.push(nextP);
      if (hist.length > 120) hist.shift();
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

// ----------------------------------------------------
// 🤖 สภาวะกรรมการ AI ย่อย (Specialized AI Agents Committee)
// ----------------------------------------------------

// AI ตัวที่ 1: แผนกคัดกรองความผันผวน & ไซด์เวย์ (Volatility & Sideway Guard Agent)
const agentSidewayGuard = (bb) => {
  const isSideway = bb.bandwidth < 0.035;
  return {
    passed: !isSideway,
    reason: isSideway ? 'DANGER: Market in Sideway Box' : 'Passed Sideway Filter'
  };
};

// AI ตัวที่ 2: แผนกวิเคราะห์แนวโน้มและความแข็งแกร่ง (Trend Analyzer Agent)
const agentTrendAnalyzer = (currentPrice, ema6, ema21) => {
  const diff = ema6 - ema21;
  const trendStrength = Math.abs(diff) / currentPrice * 1000;
  const isBullish = diff > 0;
  
  return {
    trend: isBullish ? 'BULLISH' : 'BEARISH',
    strength: trendStrength,
    passed: trendStrength > 0.15, // ถ้าแรงเหวี่ยงน้อยเกินไปถือว่าไม่ผ่านเกณฑ์เทรนด์ชัดเจน
    reason: trendStrength > 0.15 ? 'Strong Trend Detected' : 'Weak Trend / Choppy'
  };
};

// AI ตัวที่ 3: แผนกตรวจจับกับดักราคาตลาด OTC (OTC Trap Detection Agent)
const agentTrapDetector = (candleDelta, prevCandleDelta, rsi) => {
  const isBullishTrap = candleDelta < 0 && prevCandleDelta > 0 && rsi > 68;
  const isBearishTrap = candleDelta > 0 && prevCandleDelta < 0 && rsi < 32;

  if (isBullishTrap) return { detected: true, type: 'PUT', label: 'BULLISH TRAP ⚠️' };
  if (isBearishTrap) return { detected: true, type: 'CALL', label: 'BEARISH TRAP ⚠️' };
  return { detected: false, type: 'NONE', label: 'NO TRAP' };
};

// AI ตัวที่ 4: แผนกประเมินความเสี่ยงและให้คะแนนความมั่นใจ (Risk & Scoring Agent)
const agentRiskScorer = (trendResult, rsi, isVipCondition) => {
  let score = 60.0 + (trendResult.strength * 12.0);
  if (rsi > 75 || rsi < 25) score += 10.0; // Overbought/Oversold bonus
  return Math.min(Math.max(score, 50.0), 96.0);
};


// 🧠 สมองกลหลัก (Master Coordinator) สั่งการและประสานงาน AI ทุกตัวร่วมกัน
function processEngine() {
  const now = new Date();
  const seconds = now.getSeconds();
  const millis = now.getMilliseconds();
  const exactTimeLeft = parseFloat((60 - (seconds + millis / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let pairStatuses = [];

  symbols.forEach(s => {
    const prices = marketHistories[s.key];
    let state = symbolSignalStates[s.key];

    if (state.timer > 0) {
      state.timer = Math.max(0, state.timer - 0.2);
      if (state.timer === 0) {
        state.signal = 'WAIT';
        state.isVip = false;
      }
    }

    if (!prices || prices.length < 25) {
      pairStatuses.push({
        key: s.key,
        name: s.name,
        statusColor: 'green',
        statusText: 'MULTI-AI READY',
        signal: state.signal,
        confidence: '50.0',
        rsi: 50.0,
        trend: 'AI COMMITTEE INITIALIZING 🟢',
        isVip: false
      });
      return;
    }

    const currentPrice = prices[prices.length - 1];
    const prevPrice = prices[prices.length - 2] || currentPrice;
    const prev2Price = prices[prices.length - 3] || prevPrice;
    const rsi = parseFloat(calculateRSI(prices).toFixed(1));
    
    const ema6 = calculateEMA(prices, 6);
    const ema21 = calculateEMA(prices, 21);
    const bb = calculateBB(prices);

    const candleDelta = currentPrice - prevPrice;
    const prevCandleDelta = prevPrice - prev2Price;

    // --- ให้ AI แต่ละแผนกเริ่มทำงานร่วมกันเป็นทีม ---
    const sidewayCheck = agentSidewayGuard(bb);
    const trendCheck = agentTrendAnalyzer(currentPrice, ema6, ema21);
    const trapCheck = agentTrapDetector(candleDelta, prevCandleDelta, rsi);

    let aiDecision = 'WAIT';
    let statusText = 'MULTI-AI SAFE';
    let trendLabel = trendCheck.trend === 'BULLISH' ? 'BULLISH 🟢' : 'BEARISH 🔴';
    let isVipSignal = false;
    let confidence = 50.0;

    // แผนกที่ 1: ถ้าตรวจพบ Sideway ส่งต่อให้ฝ่ายคุมความเสี่ยงบล็อกทันที
    if (!sidewayCheck.passed) {
      statusText = 'DANGER (SIDEWAY AGENT BLOCKED)';
      aiDecision = 'SIDEWAY';
      confidence = 40.0;
      trendLabel = 'SIDEWAY ⚠️';
    } 
    else {
      // แผนกที่ 2 & 3: หากผ่านสิทธิ์ไซด์เวย์ ให้ AI ตรวจจับ Trap และ Trend ทำงานร่วมกัน
      confidence = agentRiskScorer(trendCheck, rsi);

      // ตัดสินใจในช่วง 3 วินาทีสุดท้ายก่อนปิดแท่ง
      if (exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0 && state.signal === 'WAIT') {
        
        // ถ้าแผนก Trap ตรวจพบกับดักราคา สั่งพลิกเกมทันที! (Priority สูงสุด)
        if (trapCheck.detected) {
          aiDecision = trapCheck.type;
          confidence = 93.5;
          isVipSignal = true;
          state.signal = trapCheck.type;
          state.timer = 30.0;
          trendLabel = trapCheck.label;
        } 
        // ถ้าไม่มี Trap ให้แผนก Trend และความแข็งแกร่งพิจารณาต่อ
        else if (trendCheck.trend === 'BULLISH' && currentPrice >= ema6 && rsi < 70) {
          aiDecision = 'CALL';
          state.signal = 'CALL';
          state.timer = 30.0;
          isVipSignal = confidence >= 85.0;
        } 
        else if (trendCheck.trend === 'BEARISH' && currentPrice <= ema6 && rsi > 30) {
          aiDecision = 'PUT';
          state.signal = 'PUT';
          state.timer = 30.0;
          isVipSignal = confidence >= 85.0;
        }
      }
    }

    let finalSignal = state.signal !== 'WAIT' ? state.signal : aiDecision;
    if (!sidewayCheck.passed) finalSignal = 'SIDEWAY';

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: !sidewayCheck.passed ? 'red' : 'green',
      statusText: statusText,
      signal: finalSignal,
      confidence: confidence.toFixed(1),
      rsi: rsi,
      trend: trendLabel,
      isVip: isVipSignal
    });
  });

  return {
    type: 'scanner_update',
    timeLeft: displayTimeLeft,
    pairs: pairStatuses
  };
}

setInterval(() => {
  const data = processEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 200);

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Multi-AI Committee OTC Engine running on port ${PORT}`));
