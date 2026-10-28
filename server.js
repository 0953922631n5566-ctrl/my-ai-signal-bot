'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const TIMEFRAME = '1min';

const PAIRS = (process.env.FOREX_PAIRS ||
  'EUR/USD,GBP/USD,USD/JPY')
  .split(',')
  .map(pair => pair.trim().toUpperCase())
  .filter(Boolean);

const MIN_SIGNAL_SCORE = clamp(
  Number(process.env.MIN_SIGNAL_SCORE || 68), 40, 95
);
const MAX_DATA_AGE_SECONDS = clamp(
  Number(process.env.MAX_DATA_AGE_SECONDS || 180), 60, 600
);
const HOLD_SECONDS = 40;
const WARNING_SECONDS = 10;

const appCache = new Map();
const lastCandleByPair = new Map();
const latestSignalByPair = new Map();
const history = [];
const manualRecords = [];

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalisePair(pair) {
  const requested = String(pair || '').trim().toUpperCase();
  return PAIRS.includes(requested) ? requested : PAIRS[0];
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values, period) {
  if (values.length < period) return null;

  let current = average(values.slice(0, period));
  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    current = values[i] * multiplier +
      current * (1 - multiplier);
  }

  return current;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  const start = closes.length - period;

  for (let i = start; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gains += change;
    if (change < 0) losses += Math.abs(change);
  }

  if (losses === 0) return gains === 0 ? 50 : 100;

  const relativeStrength = (gains / period) / (losses / period);
  return 100 - (100 / (1 + relativeStrength));
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close)
    ));
  }

  return average(ranges.slice(-period));
}

function calculateIndicators(candles) {
  const closes = candles.map(candle => candle.close);
  const ema6 = ema(closes, 6);
  const ema12 = ema(closes, 12);
  const ema21 = ema(closes, 21);
  const ema26 = ema(closes, 26);
  const ema50 = ema(closes, 50);

  return {
    ema6,
    ema12,
    ema21,
    ema26,
    ema50,
    rsi: calculateRSI(closes, 14),
    macd: ema12 !== null && ema26 !== null
      ? ema12 - ema26
      : null,
    atr: calculateATR(candles, 14)
  };
}

function analyseCandles(candles) {
  const indicators = calculateIndicators(candles);
  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  if (
    !last ||
    !previous ||
    indicators.ema6 === null ||
    indicators.ema21 === null ||
    indicators.ema50 === null ||
    indicators.rsi === null ||
    indicators.macd === null
  ) {
    return {
      signal: 'STANDBY',
      score: 0,
      callScore: 0,
      putScore: 0,
      trend: 'กำลังเก็บข้อมูล',
      reason: 'แท่งเทียนยังไม่เพียงพอ',
      indicators
    };
  }

  let callScore = 0;
  let putScore = 0;
  const reasons = [];

  if (indicators.ema6 > indicators.ema21) {
    callScore += 24;
    reasons.push('EMA6 สูงกว่า EMA21');
  } else if (indicators.ema6 < indicators.ema21) {
    putScore += 24;
    reasons.push('EMA6 ต่ำกว่า EMA21');
  }

  if (indicators.ema21 > indicators.ema50) {
    callScore += 22;
    reasons.push('แนวโน้ม EMA ขาขึ้น');
  } else if (indicators.ema21 < indicators.ema50) {
    putScore += 22;
    reasons.push('แนวโน้ม EMA ขาลง');
  }

  if (indicators.macd > 0) {
    callScore += 14;
    reasons.push('MACD เป็นบวก');
  } else if (indicators.macd < 0) {
    putScore += 14;
    reasons.push('MACD เป็นลบ');
  }

  if (indicators.rsi >= 52 && indicators.rsi <= 68) {
    callScore += 18;
    reasons.push('RSI สนับสนุน CALL');
  } else if (indicators.rsi >= 32 && indicators.rsi <= 48) {
    putScore += 18;
    reasons.push('RSI สนับสนุน PUT');
  }

  if (last.close > last.open) {
    callScore += 12;
    reasons.push('แท่งล่าสุดปิดบวก');
  } else if (last.close < last.open) {
    putScore += 12;
    reasons.push('แท่งล่าสุดปิดลบ');
  }

  if (last.close > previous.close) callScore += 10;
  if (last.close < previous.close) putScore += 10;

  callScore = clamp(Math.round(callScore), 0, 100);
  putScore = clamp(Math.round(putScore), 0, 100);

  let signal = 'STANDBY';

  if (
    callScore >= MIN_SIGNAL_SCORE &&
    callScore >= putScore + 12
  ) {
    signal = 'CALL';
  } else if (
    putScore >= MIN_SIGNAL_SCORE &&
    putScore >= callScore + 12
  ) {
    signal = 'PUT';
  }

  const trend =
    indicators.ema21 > indicators.ema50 ? 'ขาขึ้น' :
    indicators.ema21 < indicators.ema50 ? 'ขาลง' :
    'ไม่ชัดเจน';

  return {
    signal,
    score: Math.max(callScore, putScore),
    callScore,
    putScore,
    trend,
    reason: reasons.join(' · ') || 'เงื่อนไขยังไม่ชัดเจน',
    indicators
  };
}

async function fetchCandles(pair) {
  if (!API_KEY) {
    throw new Error(
      'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render Environment'
    );
  }

  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', pair);
  url.searchParams.set('interval', TIMEFRAME);
  url.searchParams.set('outputsize', '120');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', API_KEY);

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const body = await response.json();

  if (body.status === 'error' || !Array.isArray(body.values)) {
    throw new Error(
      body.message || 'Twelve Data ไม่ส่งข้อมูลแท่งเทียนกลับมา'
    );
  }

  const candles = body.values.map(item => {
    const timeText = String(item.datetime || '').replace(' ', 'T');
    const timestamp = Date.parse(`${timeText}Z`);

    return {
      time: item.datetime,
      timestamp,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    };
  }).filter(candle =>
    Number.isFinite(candle.timestamp) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close)
  ).sort((a, b) => a.timestamp - b.timestamp);

  if (candles.length < 55) {
    throw new Error(
      'ข้อมูลยังไม่พอคำนวณ EMA50 กรุณารอหรือเช็กแพ็กเกจ API'
    );
  }

  return candles;
}

function makeStandby(data, extra = {}) {
  return {
    ...data,
    signal: 'STANDBY',
    signalId: null,
    signalCreatedAt: null,
    ...extra
  };
}

async function getStatus(pair) {
  pair = normalisePair(pair);

  const cached = appCache.get(pair);
  const now = Date.now();

  // จำกัดการเรียก API เพื่อลดการใช้โควตาฟรี
  if (cached && now - cached.cachedAt < 50000) {
    const age = cached.data.signalCreatedAt
      ? now - cached.data.signalCreatedAt
      : 0;

    if (
      cached.data.signalId &&
      age > HOLD_SECONDS * 1000
    ) {
      return makeStandby(cached.data);
    }

    return { ...cached.data };
  }

  try {
    const candles = await fetchCandles(pair);
    const newest = candles[candles.length - 1];

    // หากแท่งล่าสุดยังอยู่ในนาทีปัจจุบัน ให้ใช้แท่งก่อนหน้า
    // เพื่อวิเคราะห์แท่งที่ปิดแล้ว ไม่ใช้แท่งที่ยังแกว่งอยู่
    const candle = Date.now() - newest.timestamp < 60000
      ? candles[candles.length - 2]
      : newest;

    const candleIndex = candles.findIndex(
      item => item.time === candle.time
    );
    const closedCandles = candles.slice(0, candleIndex + 1);
    const candleKey = `${pair}:${candle.time}`;
    const dataAgeSeconds = Math.max(
      0,
      Math.floor((Date.now() - candle.timestamp) / 1000)
    );
    const stale = dataAgeSeconds > MAX_DATA_AGE_SECONDS;
    const analysis = analyseCandles(closedCandles);

    let activeSignal = null;

    if (lastCandleByPair.get(pair) !== candleKey) {
      lastCandleByPair.set(pair, candleKey);

      if (
        !stale &&
        ['CALL', 'PUT'].includes(analysis.signal)
      ) {
        activeSignal = {
          id: `${candleKey}:${analysis.signal}`,
          pair,
          signal: analysis.signal,
          score: analysis.score,
          callScore: analysis.callScore,
          putScore: analysis.putScore,
          candleTime: candle.time,
          createdAt: Date.now(),
          price: candle.close,
          trend: analysis.trend,
          reason: analysis.reason
        };

        latestSignalByPair.set(pair, activeSignal);
        history.unshift(activeSignal);

        if (history.length > 500) history.length = 500;
      }
    }

    const lastSignal = latestSignalByPair.get(pair);
    const signalStillActive = lastSignal &&
      lastSignal.candleTime === candle.time &&
      Date.now() - lastSignal.createdAt <= HOLD_SECONDS * 1000;

    let signal = stale ? 'STANDBY' : analysis.signal;
    let signalId = null;
    let signalCreatedAt = null;

    if (signalStillActive && !stale) {
      signal = lastSignal.signal;
      signalId = lastSignal.id;
      signalCreatedAt = lastSignal.createdAt;
    } else if (stale) {
      signal = 'STANDBY';
    } else if (
      lastSignal &&
      Date.now() - lastSignal.createdAt > HOLD_SECONDS * 1000
    ) {
      signal = 'STANDBY';
    }

    const result = {
      ok: true,
      pair,
      timeframe: TIMEFRAME,
      source: 'Twelve Data',
      mode: 'Non-OTC reference data',
      signal,
      signalId,
      signalCreatedAt,
      holdSeconds: HOLD_SECONDS,
      score: analysis.score,
      callScore: analysis.callScore,
      putScore: analysis.putScore,
      rsi: analysis.indicators.rsi,
      trend: analysis.trend,
      reason: analysis.reason,
      dataAgeSeconds,
      latestCandleTime: candle.timestamp,
      candleTime: candle.time,
      price: candle.close,
      currentPrice: candle.close,
      stale,
      indicators: analysis.indicators,
      fetchedAt: Date.now()
    };

    appCache.set(pair, { data: result, cachedAt: Date.now() });
    return result;
  } catch (error) {
    if (cached) {
      return makeStandby(cached.data, {
        ok: false,
        stale: true,
        error: error.message
      });
    }
    throw error;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'AI Signal Radar',
    apiKeyConfigured: Boolean(API_KEY),
    timeframe: TIMEFRAME
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    timeframe: TIMEFRAME,
    pairs: PAIRS,
    minSignalScore: MIN_SIGNAL_SCORE,
    maxDataAgeSeconds: MAX_DATA_AGE_SECONDS,
    holdSeconds: HOLD_SECONDS,
    warningSeconds: WARNING_SECONDS,
    source: 'Twelve Data',
    mode: 'Non-OTC reference data'
  });
});

app.get('/api/status', async (req, res) => {
  try {
    res.json(await getStatus(req.query.pair));
  } catch (error) {
    res.status(502).json({
      ok: false,
      signal: 'STANDBY',
      stale: true,
      error: error.message
    });
  }
});

app.get('/api/scan', async (_req, res) => {
  const results = [];

  // อ่านทีละคู่ เพื่อลดการกระหน่ำเรียก API พร้อมกัน
  for (const pair of PAIRS) {
    try {
      results.push(await getStatus(pair));
    } catch (error) {
      results.push({
        ok: false,
        pair,
        signal: 'STANDBY',
        stale: true,
        error: error.message
      });
    }
  }

  res.json({ ok: true, results, fetchedAt: Date.now() });
});

app.get('/api/history', (_req, res) => {
  res.json({ ok: true, history: history.slice(0, 100) });
});

app.get('/api/history/stats', (_req, res) => {
  const wins = manualRecords.filter(r => r.outcome === 'WIN').length;
  const losses = manualRecords.filter(r => r.outcome === 'LOSS').length;

  res.json({
    ok: true,
    recorded: manualRecords.length,
    wins,
    losses,
    note: 'เป็นบันทึกผลที่ผู้ใช้กรอกเอง ไม่ใช่ผลทดสอบย้อนหลังอัตโนมัติ'
  });
});

app.get('/api/diagnostics', (_req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY),
    pairs: PAIRS,
    timeframe: TIMEFRAME,
    cachedPairs: [...appCache.keys()],
    minSignalScore: MIN_SIGNAL_SCORE,
    maxDataAgeSeconds: MAX_DATA_AGE_SECONDS
  });
});

app.post('/api/record', (req, res) => {
  const { signalId, outcome, note } = req.body || {};
  const validOutcomes = ['WIN', 'LOSS', 'SKIP'];

  if (!signalId || !validOutcomes.includes(String(outcome).toUpperCase())) {
    return res.status(400).json({
      ok: false,
      error: 'ต้องส่ง signalId และ outcome เป็น WIN, LOSS หรือ SKIP'
    });
  }

  const record = {
    signalId: String(signalId),
    outcome: String(outcome).toUpperCase(),
    note: String(note || '').slice(0, 300),
    recordedAt: Date.now()
  };

  manualRecords.unshift(record);
  if (manualRecords.length > 500) manualRecords.length = 500;

  res.json({ ok: true, record });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Signal Radar started on port ${PORT}`);
  console.log(`Pairs: ${PAIRS.join(', ')}`);

  if (!API_KEY) {
    console.warn('TWELVE_DATA_API_KEY is not configured.');
  }
});