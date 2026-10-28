
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const REQUIRE_AUTH =
  String(process.env.REQUIRE_TELEGRAM_AUTH || 'true').toLowerCase() === 'true';

const MAX_CALLS = Math.max(
  1, Number(process.env.MAX_API_CALLS_PER_DAY) || 700
);
const MIN_SCORE = Math.min(
  90, Math.max(40, Number(process.env.MIN_SIGNAL_SCORE) || 68)
);
const HOLD_SECONDS = Math.max(
  5, Math.min(120, Number(process.env.SIGNAL_HOLD_SECONDS) || 40)
);

const CACHE_MS = 15000;
const GLOBAL_FETCH_GAP_MS = 12000;
const MAX_CANDLE_CLOSE_AGE_MS = Math.max(
  75000,
  Number(process.env.MAX_CANDLE_AGE_MS) || 120000
);
const PROVIDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12000;
const HISTORY_LIMIT = 500;

const SYMBOLS = Object.freeze({
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD'
});

let dailyCalls = 0;
let quotaDate = utcDate();
let lastProviderCallAt = 0;
let providerBlockedUntil = 0;
let providerBlockReason = '';
let lastApiError = '';
let lastSuccessfulRequestAt = null;

const cache = new Map();
const inFlight = new Map();
const signalHistory = [];
const lastRecordedCandle = new Map();

// Queue provider requests globally to respect the minimum call interval.
let providerQueue = Promise.resolve();

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyCounterIfNeeded() {
  const today = utcDate();

  if (today !== quotaDate) {
    quotaDate = today;
    dailyCalls = 0;
    providerBlockedUntil = 0;
    providerBlockReason = '';
    lastApiError = '';
  }
}

function quotaState() {
  resetDailyCounterIfNeeded();

  if (!API_KEY) {
    return {
      ok: false,
      code: 'CONFIG_ERROR',
      message: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY'
    };
  }

  if (dailyCalls >= MAX_CALLS) {
    return {
      ok: false,
      code: 'API_LIMIT',
      message: 'ถึงเพดาน API รายวันที่ตั้งไว้ในแอปแล้ว'
    };
  }

  if (Date.now() < providerBlockedUntil) {
    return {
      ok: false,
      code: 'API_LIMIT',
      message: providerBlockReason
    };
  }

  return {
    ok: true,
    code: 'OK',
    message: 'พร้อมดึงข้อมูล'
  };
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') {
    return false;
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return false;

    const authDate = Number(params.get('auth_date'));
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authDate) ||
      authDate > nowSeconds + 30 ||
      nowSeconds - authDate > 86400
    ) {
      return false;
    }

    params.delete('hash');

    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secret = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const expected = crypto
      .createHmac('sha256', secret)
      .update(checkString)
      .digest();

    const actual = Buffer.from(hash, 'hex');

    return actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function requireTelegram(req, res, next) {
  if (!REQUIRE_AUTH) return next();

  const initData = req.get('x-telegram-init-data') || '';

  if (!verifyTelegramInitData(initData)) {
    return res.status(401).json({
      ok: false,
      code: 'AUTH_REQUIRED',
      message: 'กรุณาเปิด Mini App ผ่าน Telegram'
    });
  }

  next();
}

function parseCandleTime(value) {
  const text = String(value || '').trim();

  if (!text) return NaN;

  // Twelve Data is requested in UTC. Interpret timezone-less
  // timestamps as UTC, not as the Render server's local timezone.
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text.replace(' ', 'T')}Z`;

  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeCandles(values) {
  const now = Date.now();

  const sorted = (Array.isArray(values) ? values : [])
    .map(c => ({
      time: parseCandleTime(c.datetime),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close) &&
      c.open > 0 &&
      c.high >= Math.max(c.open, c.close, c.low) &&
      c.low <= Math.min(c.open, c.close, c.high)
    )
    // Only use candles whose full one-minute interval has ended.
    .filter(c => c.time + 60000 <= now)
    .sort((a, b) => a.time - b.time);

  const result = [];

  for (const c of sorted) {
    if (!result.length || c.time > result[result.length - 1].time) {
      result.push(c);
    }
  }

  return result;
}

function emaSeries(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  let value = values.slice(0, period)
    .reduce((sum, n) => sum + n, 0) / period;

  const result = Array(period - 1).fill(null);
  result.push(value);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    result.push(value);
  }

  return result;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

// Wilder RSI: seed with simple averages, then use Wilder smoothing.
function rsiSeries(values, period = 14) {
  if (values.length < period + 1) return [];

  const result = Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(0, change);
    loss += Math.max(0, -change);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  function calculate(g, l) {
    if (l === 0 && g === 0) return 50;
    if (l === 0) return 100;
    if (g === 0) return 0;
    return 100 - 100 / (1 + g / l);
  }

  result[period] = calculate(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss =
      (avgLoss * (period - 1) + Math.max(0, -change)) / period;

    result[i] = calculate(avgGain, avgLoss);
  }

  return result;
}

function rsi(values, period = 14) {
  const series = rsiSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

function trueRangeSeries(candles) {
  const result = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const previousClose = candles[i - 1].close;

    result.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - previousClose),
      Math.abs(c.low - previousClose)
    ));
  }

  return result;
}

function atr(candles, period = 14) {
  const ranges = trueRangeSeries(candles);

  if (ranges.length < period) return null;

  // Wilder-smoothed ATR.
  let value = ranges.slice(0, period)
    .reduce((sum, n) => sum + n, 0) / period;

  for (let i = period; i < ranges.length; i++) {
    value = (value * (period - 1) + ranges[i]) / period;
  }

  return value;
}

function calculateEfficiencyRatio(values, period = 10) {
  if (values.length < period + 1) return null;

  const end = values.length - 1;
  const start = end - period;

  let totalMovement = 0;

  for (let i = start + 1; i <= end; i++) {
    totalMovement += Math.abs(values[i] - values[i - 1]);
  }

  if (totalMovement === 0) return 0;

  return Math.abs(values[end] - values[start]) / totalMovement;
}

function analyze(candles) {
  const empty = {
    signal: 'STANDBY',
    score: 0,
    reason: 'ข้อมูลไม่เพียงพอ',
    marketRegime: 'UNKNOWN',
    indicators: {}
  };

  if (candles.length < 100) {
    return {
      ...empty,
      reason: 'ต้องมีแท่งเทียนอย่างน้อย 100 แท่ง'
    };
  }

  const closes = candles.map(c => c.close);
  const e8s = emaSeries(closes, 8);
  const e21s = emaSeries(closes, 21);
  const e50s = emaSeries(closes, 50);
  const e8 = e8s.at(-1);
  const e21 = e21s.at(-1);
  const e50 = e50s.at(-1);
  const rv = rsi(closes, 14);

  const macdLine = emaSeries(closes, 12).map((v, i) =>
    v === null ? null : v - emaSeries(closes, 26)[i]
  );

  const validMacd = macdLine
    .map((v, i) => ({ v, i }))
    .filter(item => Number.isFinite(item.v));

  if (validMacd.length < 35 || !Number.isFinite(rv)) {
    return {
      ...empty,
      reason: 'คำนวณ Indicator ไม่ครบ'
    };
  }

  // Build MACD signal line only from valid MACD values.
  const macdValues = validMacd.map(item => item.v);
  const signalValues = emaSeries(macdValues, 9);
  const macd = macdValues.at(-1);
  const macdSignal = signalValues.at(-1);
  const macdHist = macd - macdSignal;

  const av = atr(candles, 14);
  const er = calculateEfficiencyRatio(closes, 10);

  if (
    ![e8, e21, e50, macd, macdSignal, macdHist, av, er]
      .every(Number.isFinite) ||
    av <= 0
  ) {
    return {
      ...empty,
      reason: 'ข้อมูลไม่พร้อมสำหรับการคำนวณ'
    };
  }

  const last = candles.at(-1);
  const prev = candles.at(-2);
  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const closePosition = range > 0
    ? (last.close - last.low) / range
    : 0.5;

  const emaSpreadATR = Math.abs(e8 - e50) / av;
  const emaSlopeATR = (e8 - e8s.at(-4)) / av;
  const momentumATR = (last.close - closes.at(-4)) / av;

  const sideways = er < 0.18 && emaSpreadATR < 0.65;
  const spike = range > av * 2.5;
  const flatMarket = av / last.close < 0.000005;

  let call = 0;
  let put = 0;
  const bullish = [];
  const bearish = [];
  const warnings = [];

  // 1. Trend: EMA alignment and slope.
  if (e8 > e21 && e21 > e50) {
    call += 25;
    bullish.push('EMA เรียงตัวขาขึ้น');
  } else if (e8 < e21 && e21 < e50) {
    put += 25;
    bearish.push('EMA เรียงตัวขาลง');
  } else {
    warnings.push('EMA ยังไม่เรียงตัว');
  }

  if (emaSlopeATR > 0.08) {
    call += 8;
    bullish.push('EMA ระยะสั้นมีความชันบวก');
  } else if (emaSlopeATR < -0.08) {
    put += 8;
    bearish.push('EMA ระยะสั้นมีความชันลบ');
  }

  // 2. MACD: histogram direction, not just MACD above/below zero.
  if (macdHist > 0 && macd > 0) {
    call += 18;
    bullish.push('MACD สนับสนุนขาขึ้น');
  } else if (macdHist < 0 && macd < 0) {
    put += 18;
    bearish.push('MACD สนับสนุนขาลง');
  } else if (macdHist > 0) {
    call += 8;
    bullish.push('MACD Histogram เป็นบวก');
  } else if (macdHist < 0) {
    put += 8;
    bearish.push('MACD Histogram เป็นลบ');
  }

  // 3. RSI: momentum confirmation without chasing extremes.
  if (rv >= 52 && rv <= 68) {
    call += 15;
    bullish.push('RSI สนับสนุนแรงซื้อ');
  } else if (rv >= 32 && rv <= 48) {
    put += 15;
    bearish.push('RSI สนับสนุนแรงขาย');
  } else if (rv > 68) {
    warnings.push('RSI สูง ระวังไล่ราคา');
  } else if (rv < 32) {
    warnings.push('RSI ต่ำ ระวังแรงเด้งกลับ');
  } else {
    warnings.push('RSI ยังไม่ยืนยันทิศทาง');
  }

  // 4. Normalized momentum.
  if (momentumATR > 0.15) {
    call += 10;
    bullish.push('Momentum เป็นบวก');
  } else if (momentumATR < -0.15) {
    put += 10;
    bearish.push('Momentum เป็นลบ');
  }

  // 5. Candle confirmation and close location.
  if (
    last.close > last.open &&
    bodyRatio >= 0.45 &&
    closePosition >= 0.65 &&
    upperWick <= body * 0.8
  ) {
    call += 10;
    bullish.push('แท่งเขียวปิดใกล้จุดสูง');
  } else if (
    last.close < last.open &&
    bodyRatio >= 0.45 &&
    closePosition <= 0.35 &&
    lowerWick <= body * 0.8
  ) {
    put += 10;
    bearish.push('แท่งแดงปิดใกล้จุดต่ำ');
  }

  // 6. Price location relative to short EMA.
  if (last.close > e8 && last.close > prev.close) {
    call += 5;
    bullish.push('ราคาปิดอยู่เหนือ EMA8');
  } else if (last.close < e8 && last.close < prev.close) {
    put += 5;
    bearish.push('ราคาปิดอยู่ใต้ EMA8');
  }

  // 7. Market quality gate.
  const marketRegime = sideways
    ? 'SIDEWAYS'
    : spike
      ? 'HIGH_VOLATILITY'
      : flatMarket
        ? 'LOW_VOLATILITY'
        : 'TRENDING_OR_MIXED';

  if (sideways) warnings.push('ตลาดแกว่งออกข้าง');
  if (spike) warnings.push('แท่งล่าสุดผันผวนผิดปกติ');
  if (flatMarket) warnings.push('ความผันผวนต่ำมาก');

  let signal = 'STANDBY';
  let score = Math.max(call, put);

  if (!sideways && !spike && !flatMarket) {
    if (call >= MIN_SCORE && call >= put + 12) {
      signal = 'CALL';
      score = call;
    } else if (put >= MIN_SCORE && put >= call + 12) {
      signal = 'PUT';
      score = put;
    }
  } else {
    score = 0;
  }

  const reasons = signal === 'CALL'
    ? bullish
    : signal === 'PUT'
      ? bearish
      : warnings;

  if (signal === 'STANDBY' && reasons.length === 0) {
    reasons.push('คะแนนหรือทิศทางยังไม่ผ่านเกณฑ์');
  }

  return {
    signal,
    score: Math.min(100, Math.round(score)),
    reason: reasons.join(' · '),
    marketRegime,
    indicators: {
      ema8: e8,
      ema21: e21,
      ema50: e50,
      emaSlopeATR,
      rsi: rv,
      macd,
      macdSignal,
      macdHistogram: macdHist,
      atr: av,
      efficiencyRatio: er,
      emaSpreadATR,
      momentumATR,
      bodyRatio,
      closePosition,
      upperWick,
      lowerWick,
      bullishPoints: call,
      bearishPoints: put,
      warnings
    }
  };
}

function isQuotaError(message, status) {
  const t = String(message || '').toLowerCase();

  return status === 429 ||
    t.includes('api credits') ||
    t.includes('credit') ||
    t.includes('rate limit') ||
    t.includes('run out') ||
    t.includes('limit exceeded') ||
    t.includes('quota');
}

function unavailable(symbol, code, message, previous) {
  const closeMs = previous?.candleCloseTime
    ? Date.parse(previous.candleCloseTime)
    : NaN;

  return {
    ok: false,
    code,
    message,
    symbol,
    pair: SYMBOLS[symbol] || symbol,
    dataFresh: false,
    price: previous?.price ?? null,
    candleTime: previous?.candleTime ?? null,
    candleCloseTime: previous?.candleCloseTime ?? null,
    fetchedAt: previous?.fetchedAt ?? null,
    dataAgeSeconds: Number.isFinite(closeMs)
      ? Math.max(0, Math.floor((Date.now() - closeMs) / 1000))
      : null,
    signal: 'STANDBY',
    score: 0,
    reason: 'ข้อมูลไม่พร้อม — หยุดสัญญาณใหม่',
    marketRegime: 'UNKNOWN',
    indicators: previous?.indicators ?? {},
    candles: previous?.candles ?? []
  };
}

function checkCached(symbol) {
  const previous = cache.get(symbol);
  if (!previous) return null;

  const closeMs = Date.parse(previous.candleCloseTime);
  const ageMs = Date.now() - closeMs;

  if (
    !Number.isFinite(closeMs) ||
    ageMs < 0 ||
    ageMs > MAX_CANDLE_CLOSE_AGE_MS
  ) {
    return unavailable(
      symbol,
      'DATA_STALE',
      'ข้อมูลแท่งเทียนเก่าเกินเกณฑ์',
      previous
    );
  }

  return {
    ...previous,
    dataAgeSeconds: Math.floor(ageMs / 1000),
    dataFresh: true
  };
}

function rememberSignal(data) {
  // Record at most one result per completed candle and pair.
  const key = `${data.symbol}:${data.candleTime}`;

  if (lastRecordedCandle.get(data.symbol) === data.candleTime) {
    return;
  }

  lastRecordedCandle.set(data.symbol, data.candleTime);

  signalHistory.unshift({
    id: crypto.randomUUID(),
    symbol: data.symbol,
    pair: data.pair,
    candleTime: data.candleTime,
    candleCloseTime: data.candleCloseTime,
    createdAt: new Date().toISOString(),
    signal: data.signal,
    score: data.score,
    price: data.price,
    reason: data.reason,
    marketRegime: data.marketRegime,
    outcome: null
  });

  if (signalHistory.length > HISTORY_LIMIT) {
    signalHistory.length = HISTORY_LIMIT;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueProviderRequest(task) {
  const job = providerQueue.then(async () => {
    const elapsed = Date.now() - lastProviderCallAt;
    const remaining = GLOBAL_FETCH_GAP_MS - elapsed;

    if (remaining > 0) await wait(remaining);

    // Recheck after waiting: another request may have used the quota.
    const quota = quotaState();

    if (!quota.ok) {
      const error = new Error(quota.message);
      error.code = quota.code;
      throw error;
    }

    lastProviderCallAt = Date.now();
    dailyCalls += 1;

    return task();
  });

  providerQueue = job.catch(() => {});
  return job;
}

async function requestTwelveData(symbol) {
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', SYMBOLS[symbol]);
  url.searchParams.set('interval', '1min');
  url.searchParams.set('outputsize', '120');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  const raw = await response.text();
  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`ผู้ให้บริการส่งข้อมูลที่อ่านไม่ได้ (HTTP ${response.status})`);
  }

  if (!response.ok || body.status === 'error' || body.code) {
    const message = body.message || `HTTP ${response.status}`;

    if (isQuotaError(message, response.status)) {
      providerBlockedUntil = Date.now() + PROVIDER_COOLDOWN_MS;
      providerBlockReason =
        'ผู้ให้บริการจำกัดโควตาหรือความถี่ พักการเรียก API ชั่วคราว';
    }

    throw new Error(message);
  }

  return body;
}

async function fetchMarket(symbol) {
  resetDailyCounterIfNeeded();

  const cached = cache.get(symbol);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_MS) {
    return checkCached(symbol);
  }

  if (inFlight.has(symbol)) return inFlight.get(symbol);

  const quota = quotaState();

  if (!quota.ok) {
    return unavailable(symbol, quota.code, quota.message, cached);
  }

  const job = (async () => {
    try {
      const body = await enqueueProviderRequest(
        () => requestTwelveData(symbol)
      );

      const candles = normalizeCandles(body.values);

      if (candles.length < 100) {
        throw new Error('มีแท่งเทียนที่ปิดแล้วไม่ถึง 100 แท่ง');
      }

      const last = candles.at(-1);
      const closeMs = last.time + 60000;
      const ageMs = Date.now() - closeMs;

      if (ageMs < 0 || ageMs > MAX_CANDLE_CLOSE_AGE_MS) {
        throw new Error('ข้อมูลแท่งเทียนเก่าเกินเกณฑ์');
      }

      const result = analyze(candles);

      const data = {
        ok: true,
        code: 'OK',
        symbol,
        pair: SYMBOLS[symbol],
        price: last.close,
        candleTime: new Date(last.time).toISOString(),
        candleCloseTime: new Date(closeMs).toISOString(),
        fetchedAt: Date.now(),
        dataAgeSeconds: Math.floor(ageMs / 1000),
        dataFresh: true,
        signal: result.signal,
        score: result.score,
        reason: result.reason,
        marketRegime: result.marketRegime,
        indicators: result.indicators,
        candles: candles.slice(-30).map(c => ({
          time: new Date(c.time).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }))
      };

      cache.set(symbol, data);
      rememberSignal(data);
      lastApiError = '';
      lastSuccessfulRequestAt = Date.now();

      return data;
    } catch (error) {
      lastApiError = String(error.message || 'API request failed');

      const code = error.code ||
        (isQuotaError(lastApiError, 0) ? 'API_LIMIT' : 'DATA_STALE');

      return unavailable(symbol, code, lastApiError, cache.get(symbol));
    } finally {
      inFlight.delete(symbol);
    }
  })();

  inFlight.set(symbol, job);
  return job;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'AI Signal Radar',
    time: new Date().toISOString()
  });
});

app.get('/api/config', requireTelegram, (req, res) => {
  res.json({
    ok: true,
    symbols: Object.keys(SYMBOLS),
    interval: '1min',
    minimumScore: MIN_SCORE,
    signalHoldSeconds: HOLD_SECONDS,
    prepareBeepSeconds: 10,
    entrySignalSeconds: 5,
    maxCallsPerDay: MAX_CALLS,
    source: 'Twelve Data',
    market: 'Forex Non-OTC',
    automaticTrading: false
  });
});

app.get('/api/status', requireTelegram, (req, res) => {
  resetDailyCounterIfNeeded();
  const q = quotaState();

  res.json({
    ok: true,
    apiConfigured: Boolean(API_KEY),
    status: q.code,
    message: q.message,
    dailyCalls,
    maxCallsPerDay: MAX_CALLS,
    remainingLocalCalls: Math.max(0, MAX_CALLS - dailyCalls),
    quotaDateUTC: quotaDate,
    lastProviderCallAt: lastProviderCallAt || null,
    lastSuccessfulRequestAt,
    lastApiError,
    providerBlockedUntil:
      providerBlockedUntil > Date.now() ? providerBlockedUntil : null,
    cachedSymbols: [...cache.keys()],
    queuedOrRunningSymbols: [...inFlight.keys()]
  });
});

app.get('/api/market', requireTelegram, async (req, res) => {
  const symbol = String(req.query.symbol || 'EURUSD').toUpperCase();

  if (!Object.hasOwn(SYMBOLS, symbol)) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_SYMBOL',
      message: 'ไม่รองรับคู่เงินนี้',
      supportedSymbols: Object.keys(SYMBOLS)
    });
  }

  try {
    const result = await fetchMarket(symbol);
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์',
      signal: 'STANDBY',
      score: 0
    });
  }
});

app.get('/api/signals/history', requireTelegram, (req, res) => {
  const limit = Math.min(
    100,
    Math.max(1, Number(req.query.limit) || 50)
  );

  res.json({
    ok: true,
    persistent: false,
    items: signalHistory.slice(0, limit),
    message: 'ประวัตินี้เก็บในหน่วยความจำและจะหายเมื่อเซิร์ฟเวอร์เริ่มใหม่'
  });
});

// Catch-all for the Mini App.
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      code: 'NOT_FOUND'
    });
  }

  res.sendFile(
    path.join(__dirname, 'public', 'index.html'),
    err => {
      if (err) next(err);
    }
  );
});

app.listen(PORT, () => {
  console.log(`AI Signal Radar running on port ${PORT}`);
  console.log(`Telegram authentication: ${REQUIRE_AUTH ? 'ON' : 'OFF'}`);
  console.log(`Market source: Twelve Data Forex Non-OTC`);
  console.log(`Minimum signal score: ${MIN_SCORE}`);
});
