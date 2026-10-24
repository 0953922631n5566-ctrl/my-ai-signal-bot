const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// 🧠 ส่วนตั้งค่าระบบ Quant และเกณฑ์การให้คะแนนระดับโปร
const CONFIG = {
  historyLimit: 3000,
  minBars: 60,
  fastEMA: 6,
  slowEMA: 21,
  rsiPeriod: 14,
  minScore: 70,
  minScoreGap: 20,
  cooldownMs: 60_000,
  expiryMs: 60_000,
  maxBarAgeMs: 120_000
};

// ฟังก์ชันคำนวณ EMA มาตรฐาน
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

// ฟังก์ชันคำนวณ RSI สูตรดั้งเดิมของ Wilder (แม่นยำสูง)
function rsiWilder(values, period = 14) {
  if (values.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// 📊 ระบบวิเคราะห์และให้คะแนน (Scoring Engine)
function analyze(candles, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length < CONFIG.minBars) {
    return { signal: 'WAIT', reason: 'INSUFFICIENT_DATA' };
  }
  const bars = candles.slice(-CONFIG.historyLimit);
  const last = bars[bars.length - 1];
  if (now - last.time > CONFIG.maxBarAgeMs) {
    return { signal: 'WAIT', reason: 'STALE_DATA' };
  }
  const closes = bars.map(b => b.close);
  if (closes.some(p => !Number.isFinite(p) || p <= 0)) {
    return { signal: 'WAIT', reason: 'INVALID_PRICE' };
  }
  const fast = ema(closes, CONFIG.fastEMA);
  const slow = ema(closes, CONFIG.slowEMA);
  const rsi = rsiWilder(closes, CONFIG.rsiPeriod);

  if (fast == null || slow == null || rsi == null) {
    return { signal: 'WAIT', reason: 'INDICATORS_NOT_READY' };
  }

  const recent = closes.slice(-20);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((sum, p) => sum + (p - mean) ** 2, 0) / recent.length;
  const volatilityPct = mean > 0 ? Math.sqrt(variance) / mean * 100 : 0;

  if (volatilityPct < 0.005) {
    return { signal: 'WAIT', reason: 'LOW_VOLATILITY', rsi: Number(rsi.toFixed(2)) };
  }

  const current = closes[closes.length - 1];
  const prior = closes[closes.length - 2];
  const earlier = closes[closes.length - 4] || prior;

  const momentum = (current - prior) / prior;
  const shortMove = (current - earlier) / earlier;

  let call = 0;
  let put = 0;

  if (fast > slow) call += 35;
  if (fast < slow) put += 35;
  if (current > fast) call += 15;
  if (current < fast) put += 15;
  if (rsi >= 52 && rsi <= 68) call += 20;
  if (rsi >= 32 && rsi <= 48) put += 20;
  if (momentum > 0) call += 15;
  if (momentum < 0) put += 15;
  if (shortMove > 0) call += 15;
  if (shortMove < 0) put += 15;

  let signal = 'WAIT';
  if (call >= CONFIG.minScore && call - put >= CONFIG.minScoreGap && rsi < 70) {
    signal = 'CALL';
  } else if (put >= CONFIG.minScore && put - call >= CONFIG.minScoreGap && rsi > 30) {
    signal = 'PUT';
  }

  return {
    signal,
    reason: signal === 'WAIT' ? 'FILTERED' : 'RULES_CONFIRMED',
    score: Math.max(call, put),
    rsi: Number(rsi.toFixed(2)),
    trend: fast > slow ? 'BULLISH' : (fast < slow ? 'BEARISH' : 'NEUTRAL'),
    candleTime: last.time,
    entryReference: current,
    expiryMs: CONFIG.expiryMs
  };
}

// 🛡️ ระบบจัดการและควบคุมจังหวะสัญญาณ (Cooldown Manager)
function createSignalManager() {
  const lastSignals = new Map();
  function evaluate(symbol, candles, now = Date.now()) {
    const result = analyze(candles, now);
    if (result.signal === 'WAIT') return result;
    const last = lastSignals.get(symbol);
    if (last && (last.candleTime === result.candleTime || now - last.createdAt < CONFIG.cooldownMs)) {
      return { ...result, signal: 'WAIT', reason: 'COOLDOWN' };
    }
    lastSignals.set(symbol, { candleTime: result.candleTime, createdAt: now });
    return { ...result, symbol, createdAt: now, mode: 'SIGNAL_ONLY' };
  }
  return { evaluate };
}

const signalManager = createSignalManager();

// รายชื่อคู่เงิน OTC ทั้งหมด
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
symbols.forEach(s => {
  marketHistories[s.key] = [];
  let p = s.base;
  let nowTime = Date.now() - (100 * 60 * 1000);
  for (let i = 0; i < 100; i++) {
    p += (Math.random() - 0.49) * (p * 0.0003);
    marketHistories[s.key].push({
      time: nowTime + (i * 60 * 1000),
      open: p,
      high: p * 1.0005,
      low: p * 0.9995,
      close: parseFloat(p.toFixed(5))
    });
  }
});

// จำลองการขยับราคาแบบเรียลไทม์สร้างแท่งเทียนจำลองที่สมจริง
setInterval(() => {
  const now = Date.now();
  symbols.forEach(s => {
    const candles = marketHistories[s.key];
    if (candles && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const change = (Math.random() - 0.492) * (lastCandle.close * 0.00045);
      const newClose = parseFloat((lastCandle.close + change).toFixed(5));
      
      if (now - lastCandle.time < 60000) {
        lastCandle.close = newClose;
        lastCandle.high = Math.max(lastCandle.high, newClose);
        lastCandle.low = Math.min(lastCandle.low, newClose);
      } else {
        candles.push({
          time: now,
          open: newClose,
          high: newClose,
          low: newClose,
          close: newClose
        });
        if (candles.length > 3000) candles.shift();
      }
    }
  });
}, 1000);

// ประมวลผลส่งข้อมูลสแกนเนอร์ให้หน้าเว็บ
function processEngine() {
  const now = Date.now();
  const seconds = Math.floor((now / 1000) % 60);
  const exactTimeLeft = parseFloat((60 - (seconds + (now % 1000) / 1000)).toFixed(1));
  const displayTimeLeft = Math.ceil(exactTimeLeft);

  let pairStatuses = [];

  symbols.forEach(s => {
    const candles = marketHistories[s.key];
    const evaluation = signalManager.evaluate(s.key, candles, now);

    let signal = evaluation.signal;
    let score = evaluation.score || 50;
    let rsiVal = evaluation.rsi || 50;
    let trendStr = evaluation.trend || 'NEUTRAL';
    let statusText = evaluation.reason === 'RULES_CONFIRMED' ? 'OTC SAFE' : (evaluation.reason || 'ACTIVE');

    pairStatuses.push({
      key: s.key,
      name: s.name,
      statusColor: signal === 'WAIT' ? 'green' : 'green',
      statusText: statusText,
      signal: signal,
      confidence: score.toFixed(1),
      rsi: rsiVal,
      trend: trendStr + (trendStr === 'BULLISH' ? ' 🟢' : trendStr === 'BEARISH' ? ' 🔴' : ' ⚪'),
      isVip: score >= 85
    });
  });

  return {
    type: 'scanner_update',
    timeLeft: displayTimeLeft,
    pairs: pairStatuses
  };
}

// ส่งข้อมูลผ่าน WebSocket ทุกๆ 200ms
setInterval(() => {
  const data = processEngine();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}, 200);

// รองรับ Port บน Render 100%
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Professional Quant OTC Engine running on port ${PORT}`));
