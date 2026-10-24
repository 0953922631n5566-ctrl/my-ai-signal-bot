const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// คู่เงิน OTC ยอดนิยมใน IQ Option
const symbols = [
  { key: 'eurusd_otc', name: 'EUR/USD (OTC)', base: 1.0850 },
  { key: 'gbpusd_otc', name: 'GBP/USD (OTC)', base: 1.3400 },
  { key: 'usdjpy_otc', name: 'USD/JPY (OTC)', base: 155.00 },
  { key: 'audusd_otc', name: 'AUD/USD (OTC)', base: 0.6550 },
  { key: 'nzddusd_otc', name: 'NZD/USD (OTC)', base: 0.6050 },
  { key: 'usdcad_otc', name: 'USD/CAD (OTC)', base: 1.3550 },
  { key: 'eurjpy_otc', name: 'EUR/JPY (OTC)', base: 167.50 },
  { key: 'gbpjpy_otc', name: 'GBP/JPY (OTC)', base: 197.50 }
];

let marketHistories = {};
let symbolSignalStates = {}; 

symbols.forEach(s => {
  marketHistories[s.key] = [];
  symbolSignalStates[s.key] = { signal: 'WAIT', timer: 0, confidence: '50.0', isVip: false };
  
  let p = s.base;
  for (let i = 0; i < 50; i++) {
    p += (Math.random() - 0.495) * (p * 0.0005); // ปรับอัลกอริทึมให้สะบัดแบบ OTC
    marketHistories[s.key].push(parseFloat(p.toFixed(5)));
  }
});

// จำลองราคาขยับสไตล์ OTC (มีความผันผวนสูงกว่าตลาดปกติ)
setInterval(() => {
  symbols.forEach(s => {
    const hist = marketHistories[s.key];
    if (hist && hist.length > 0) {
      const last = hist[hist.length - 1];
      const change = (Math.random() - 0.495) * (last * 0.0005);
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

// 🧠 ระบบ AI ประมวลผลและอ่านพฤติกรรมกราฟ OTC
function processOTCEngine() {
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

    if (!prices || prices.length < 30) {
      pairStatuses.push({
        key: s.key,
        name: s.name,
        statusColor: 'green',
        statusText: 'OTC READY',
        signal: state.signal,
        confidence: '50.0',
        rsi: 50.0,
        trend: 'ANALYZING 🟢',
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

    // อ่านการสะบัดตัวของไส้เทียน OTC
    const candleChange = currentPrice - prevPrice;
    const prevChange = prevPrice - prev2Price;
    const isSideway = bb.bandwidth < 0.038;

    // ระบบจับกับดัก OTC (OTC Trap Reversal Logic)
    const isOTCBullTrap = candleChange < 0 && prevChange > 0 && rsi >= 67.0; // ทำท่าขึ้นเพื่อตบลง
    const isOTCBearTrap = candleChange > 0 && prevChange < 0 && rsi <= 33.0; // ทำท่าลงเพื่อตบขึ้น

    let aiConfidence = 50.0;
    let isVipSignal = false;
    let statusText = 'OTC SAFE';

    if (isSideway) {
      statusText = 'DANGER (OTC SIDEWAY)';
      aiConfidence = 40.0;
    } else {
      const trendDiff = Math.abs(ema6 - ema21) / currentPrice * 1000;
      aiConfidence = Math.min(62.0 + (trendDiff * 14.0), 95.0);

      // 🎯 ส่งสัญญาณช่วง 3 วินาทีสุดท้ายก่อนเปลี่ยนแท่ง
      if (exactTimeLeft <= 3.0 && exactTimeLeft >= 0.0 && state.signal === 'WAIT') {
        
        if (isOTCBullTrap) {
          // สลับขั้วสวนทันที: เจอหลอกพุ่งขึ้นใน OTC -> สั่ง PUT
          state.signal = 'PUT';
          state.timer = 30.0;
          state.confidence = '93.0';
          state.isVip = true;
        } 
        else if (isOTCBearTrap) {
          // สลับขั้วสวนทันที: เจอหลอกทุบลงใน OTC -> สั่ง CALL
          state.signal = 'CALL';
          state.timer = 30.0;
          state.confidence = '93.0';
          state.isVip = true;
        }
        else if (ema6 > ema21 && currentPrice >= ema6 && rsi < 68) {
          state.signal = 'CALL';
          state.timer = 30.0;
          state.confidence = aiConfidence.toFixed(1);
          state.isVip = aiConfidence >= 86.0;
        }
        else if (ema6 < ema21 && currentPrice <= ema6 && rsi > 32) {
          state.signal = 'PUT';
          state.timer = 30.0;
          state.confidence = aiConfidence.toFixed(1);
          state.isVip = aiConfidence >= 86.0;
        }
      }
    }

    let finalSignal = state.signal;
    if (isSideway) finalSignal = 'SIDEWAY';

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: isSideway ? 'red' : 'green',
      statusText: statusText,
      signal: finalSignal,
      confidence: state.signal !== 'WAIT' ? state.confidence : aiConfidence.toFixed(1),
      rsi: rsi,
      trend: isOTCBullTrap ? 'OTC TRAP ⚠️' : (isOTCBearTrap ? 'OTC TRAP ⚠️' : (ema6 > ema21 ? 'BULLISH 🟢' : 'BEARISH 🔴')),
      isVip: state.isVip
    });
  });

  return {
    type: 'scanner_update',
    timeLeft: displayTimeLeft,
    pairs: pairStatuses
  };
}

setInterval(() => {
  const data = processOTCEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 200);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`OTC Engine running on port ${PORT}`));
