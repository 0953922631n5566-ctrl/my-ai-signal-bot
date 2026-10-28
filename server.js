
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
// 1. CONFIGURATION
// =====================================================

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const REQUIRE_AUTH =
  String(process.env.REQUIRE_TELEGRAM_AUTH || 'true').toLowerCase() === 'true';

const MAX_CALLS = Math.max(
  1,
  Number(process.env.MAX_API_CALLS_PER_DAY) || 700
);

const MIN_SCORE = Math.min(
  90,
  Math.max(40, Number(process.env.MIN_SIGNAL_SCORE) || 68)
);

const HOLD_SECONDS = Math.max(
  5,
  Math.min(120, Number(process.env.SIGNAL_HOLD_SECONDS) || 40)
);

// Minimum time between provider API requests.
const GLOBAL_FETCH_GAP_MS = Math.max(
  1000,
  Number(process.env.GLOBAL_FETCH_GAP_MS) || 12000
);

// Do not refetch a pair repeatedly while the same candle is current.
const CACHE_FALLBACK_MS = 15000;
const CANDLE_REFRESH_GRACE_MS = 2000;

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

// =====================================================
// 2. RUNTIME STATE
// =====================================================

// These counters are local to this server process.
// They reset when Render restarts the service.
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

// =====================================================
// 3. TELEGRAM MINI APP AUTHENTICATION
// =====================================================

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') {
    return false;
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      return false;
    }

    const authDate = Number(params.get('auth_date'));
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Retain the existing 24-hour window for compatibility.
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

    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(actual, expected)
    );
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

// =====================================================
// 4. CANDLE DATA NORMALIZATION
// =====================================================

function parseCandleTime(value) {
  const text = String(value || '').trim();

  if (!text) return NaN;

  // Twelve Data is requested in UTC.
  // Treat timestamps without a timezone as UTC.
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
    // Only use fully closed one-minute candles.
    .filter(c => c.time + 60000 <= now)
    .sort((a, b) => a.time - b.time);

  const result = [];

  for (const candle of sorted) {
    if (
      !result.length ||
      candle.time > result[result.length - 1].time
    ) {
      result.push(candle);
    }
  }

  return result;
}

// =====================================================
// 5. TECHNICAL INDICATORS
// =====================================================

function emaSeries(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((sum, n) => sum + n, 0) / period;

  const result = Array(period - 1).fill(null);
  result.push(value);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    result.push(value);
  }

  return result;
}

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
    if (g === 0 && l === 0) return 50;
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

function trueRangeSeries(candles) {
  const result = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;

    result.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)
    ));
  }

  return result;
}

function atr(candles, period = 14) {
  const ranges = trueRangeSeries(candles);

  if (ranges.length < period) return null;

  let value = ranges
    .slice(0, period)
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

// =====================================================
// 6. SIGNAL ANALYSIS
// =====================================================

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
      reason: 'ต้องมีแท่งเทียนที่ปิดแล้วอย่างน้อย 100 แท่ง'
    };
  }

  const closes = candles.map(c => c.close);

  const ema8Series = emaSeries(closes, 8);
  const ema21Series = emaSeries(closes, 21);
  const ema50Series = emaSeries(closes, 50);

  const ema8 = ema8Series.at(-1);
  const ema21 = ema21Series.at(-1);
  const ema50 = ema50Series.at(-1);

  const rsiValues = rsiSeries(closes, 14);
  const rsiValue = rsiValues.at(-1);

  // IMPORTANT:
  // Compute EMA12 and EMA26 only once.
  // Do not subtract null EMA26 values from valid EMA12 values.
  const ema12Series = emaSeries(closes, 12);
  const ema26Series = emaSeries(closes, 26);

  const macdValues = [];

  for (let i = 0; i < closes.length; i++) {
    const fast = ema12Series[i];
    const slow = ema26Series[i];

    if (Number.isFinite(fast) && Number.isFinite(slow)) {
      macdValues.push(fast - slow);
    }
  }

  // The MACD signal EMA is calculated from valid MACD values only.
  const macdSignalSeries = emaSeries(macdValues, 9);

  const macd = macdValues.at(-1);
  const macdSignal = macdSignalSeries.at(-1);

  const macdHistogram =
    Number.isFinite(macd) && Number.isFinite(macdSignal)
      ? macd - macdSignal
      : null;

  const atrValue = atr(candles, 14);
  const efficiencyRatio = calculateEfficiencyRatio(closes, 10);

  const required = [
    ema8,
    ema21,
    ema50,
    rsiValue,
    macd,
    macdSignal,
    macdHistogram,
    atrValue,
    efficiencyRatio,
    ema8Series.at(-4)
  ];

  if (
    !required.every(Number.isFinite) ||
    atrValue <= 0
  ) {
    return {
      ...empty,
      reason: 'ข้อมูลไม่พร้อมสำหรับการคำนวณ Indicator'
    };
  }

  const last = candles.at(-1);
  const previous = candles.at(-2);

  const range = last.high - last.low;
  const body = Math.abs(last.close - last.open);

  const bodyRatio = range > 0 ? body / range : 0;

  const upperWick =
    last.high - Math.max(last.open, last.close);

  const lowerWick =
    Math.min(last.open, last.close) - last.low;

  const closePosition = range > 0
    ? (last.close - last.low) / range
    : 0.5;

  const emaSpreadATR = Math.abs(ema8 - ema50) / atrValue;
  const emaSlopeATR = (ema8 - ema8Series.at(-4)) / atrValue;
  const momentumATR = (last.close - closes.at(-4)) / atrValue;

  const sideways =
    efficiencyRatio < 0.18 &&
    emaSpreadATR < 0.65;

  const spike = range > atrValue * 2.5;

  const flatMarket =
    atrValue / last.close < 0.000005;

  let call = 0;
  let put = 0;

  const bullish = [];
  const bearish = [];
  const warnings = [];

  // 1. Trend alignment.
  if (ema8 > ema21 && ema21 > ema50) {
    call += 25;
    bullish.push('EMA เรียงตัวขาขึ้น');
  } else if (ema8 < ema21 && ema21 < ema50) {
    put += 25;
    bearish.push('EMA เรียงตัวขาลง');
  } else {
    warnings.push('EMA ยังไม่เรียงตัวชัดเจน');
  }

  // 2. Short-term EMA slope.
  if (emaSlopeATR > 0.08) {
    call += 8;
    bullish.push('ความชัน EMA เป็นบวก');
  } else if (emaSlopeATR < -0.08) {
    put += 8;
    bearish.push('ความชัน EMA เป็นลบ');
  }

  // 3. MACD and histogram confirmation.
  if (macdHistogram > 0 && macd > 0) {
    call += 18;
    bullish.push('MACD สนับสนุนขาขึ้น');
  } else if (macdHistogram < 0 && macd < 0) {
    put += 18;
    bearish.push('MACD สนับสนุนขาลง');
  } else if (macdHistogram > 0) {
    call += 8;
    bullish.push('MACD Histogram เป็นบวก');
  } else if (macdHistogram < 0) {
    put += 8;
    bearish.push('MACD Histogram เป็นลบ');
  }

  // 4. RSI confirmation without chasing extremes.
  if (rsiValue >= 52 && rsiValue <= 68) {
    call += 15;
    bullish.push('RSI สนับสนุนแรงซื้อ');
  } else if (rsiValue >= 32 && rsiValue <= 48) {
    put += 15;
    bearish.push('RSI สนับสนุนแรงขาย');
  } else if (rsiValue > 68) {
    warnings.push('RSI สูง ระวังไล่ราคา');
  } else if (rsiValue < 32) {
    warnings.push('RSI ต่ำ ระวังแรงเด้งกลับ');
  } else {
    warnings.push('RSI ยังไม่ยืนยันทิศทาง');
  }

  // 5. Normalized momentum.
  if (momentumATR > 0.15) {
    call += 10;
    bullish.push('Momentum เป็นบวก');
  } else if (momentumATR < -0.15) {
    put += 10;
    bearish.push('Momentum เป็นลบ');
  }

  // 6. Closed-candle confirmation.
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

  // 7. Price position relative to EMA8.
  if (last.close > ema8 && last.close > previous.close) {
    call += 5;
    bullish.push('ราคาปิดเหนือ EMA8');
  } else if (
    last.close < ema8 &&
    last.close < previous.close
  ) {
    put += 5;
    bearish.push('ราคาปิดใต้ EMA8');
  }

  // 8. Market quality filters.
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
      ema8,
      ema21,
      ema50,
      emaSlopeATR,
      rsi: rsiValue,
      macd,
      macdSignal,
      macdHistogram,
      atr: atrValue,
      efficiencyRatio,
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

// =====================================================
// 7. PROVIDER ERROR HANDLING
// =====================================================

function isQuotaError(message, status) {
  const text = String(message || '').toLowerCase();

  return (
    status === 429 ||
    text.includes('api credits') ||
    text.includes('credit') ||
    text.includes('rate limit') ||
    text.includes('run out') ||
    text.includes('limit exceeded') ||
    text.includes('quota')
  );
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

// =====================================================
// 8. SIGNAL HISTORY — ONE RECORD PER PAIR AND CANDLE
// =====================================================

function rememberSignal(data) {
  if (!data.ok || !data.candleTime) return;

  const lastTime = lastRecordedCandle.get(data.symbol);

  if (lastTime === data.candleTime) return;

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

// =====================================================
// 9. PROVIDER QUEUE — GLOBAL REQUEST THROTTLING
// =====================================================

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueueProviderRequest(task) {
  const job = providerQueue.then(async () => {
    const elapsed = Date.now() - lastProviderCallAt;
    const remaining = GLOBAL_FETCH_GAP_MS - elapsed;

    if (remaining > 0) {
      await wait(remaining);
    }

    // Recheck after waiting, before consuming a local call.
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

  // Keep the queue usable even if a request fails.
  providerQueue = job.catch(() => {});

  return job;
}

// =====================================================
// 10. TWELVE DATA REQUEST
// =====================================================

async function requestTwelveData(symbol) {
  const url = new URL(
    'https://api.twelvedata.com/time_series'
  );

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
    throw new Error(
      `ผู้ให้บริการส่งข้อมูลที่อ่านไม่ได้ (HTTP ${response.status})`
    );
  }

  if (
    !response.ok ||
    body.status === 'error' ||
    body.code
  ) {
    const message = body.message || `HTTP ${response.status}`;

    if (isQuotaError(message, response.status)) {
      providerBlockedUntil = Date.now() + PROVIDER_COOLDOWN_MS;
      providerBlockReason =
        'ผู้ให้บริการจำกัดโควตาหรือความถี่ ระบบพักการเรียก API ชั่วคราว';
    }

    throw new Error(message);
  }

  if (!Array.isArray(body.values)) {
    throw new Error('ไม่พบรายการแท่งเทียนจาก Twelve Data');
  }

  return body;
}

// =====================================================
// 11. MARKET FETCH — CACHE + IN-FLIGHT DEDUPLICATION
// =====================================================

async function fetchMarket(symbol) {
  resetDailyCounterIfNeeded();

  const cached = cache.get(symbol);
  const now = Date.now();

  if (cached) {
    const closeMs = Date.parse(cached.candleCloseTime);
    const ageMs = now - closeMs;

    const stillFresh =
      Number.isFinite(closeMs) &&
      ageMs >= 0 &&
      ageMs <= MAX_CANDLE_CLOSE_AGE_MS;

    // Reuse the cached candle until the next minute should be
    // available. This prevents every UI refresh from spending API calls.
    const refreshAfter = cached._refreshAfter || 0;

    if (stillFresh && now < refreshAfter) {
      return checkCached(symbol);
    }
  }

  // If the same pair is already being fetched, share that request.
  if (inFlight.has(symbol)) {
    return inFlight.get(symbol);
  }

  const quota = quotaState();

  if (!quota.ok) {
    return unavailable(
      symbol,
      quota.code,
      quota.message,
      cached
    );
  }

  const job = (async () => {
    try {
      const body = await enqueueProviderRequest(
        () => requestTwelveData(symbol)
      );

      const candles = normalizeCandles(body.values);

      if (candles.length < 100) {
        throw new Error(
          'มีแท่งเทียนที่ปิดแล้วไม่ถึง 100 แท่ง'
        );
      }

      const last = candles.at(-1);
      const closeMs = last.time + 60000;
      const ageMs = Date.now() - closeMs;

      if (
        ageMs < 0 ||
        ageMs > MAX_CANDLE_CLOSE_AGE_MS
      ) {
        throw new Error('ข้อมูลแท่งเทียนเก่าเกินเกณฑ์');
      }

      const analysis = analyze(candles);

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
        signal: analysis.signal,
        score: analysis.score,
        reason: analysis.reason,
        marketRegime: analysis.marketRegime,
        indicators: analysis.indicators,
        candles: candles.slice(-30).map(c => ({
          time: new Date(c.time).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }))
      };

      // Refresh shortly after the next one-minute candle closes.
      // Each pair normally needs only one request per candle cycle.
      const refreshAfter =
        closeMs + 60000 + CANDLE_REFRESH_GRACE_MS;

      cache.set(symbol, {
        ...data,
        _refreshAfter: refreshAfter
      });

      rememberSignal(data);

      lastApiError = '';
      lastSuccessfulRequestAt = Date.now();

      return data;
    } catch (error) {
      const message = String(
        error.message || 'API request failed'
      );

      lastApiError = message;

      const code = error.code ||
        (isQuotaError(message, 0)
          ? 'API_LIMIT'
          : 'DATA_STALE');

      return unavailable(
        symbol,
        code,
        message,
        cache.get(symbol)
      );
    } finally {
      inFlight.delete(symbol);
    }
  })();

  inFlight.set(symbol, job);

  return job;
}

// =====================================================
// 12. HTTP ENDPOINTS
// =====================================================

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
    globalFetchGapMs: GLOBAL_FETCH_GAP_MS,
    source: 'Twelve Data',
    market: 'Forex Non-OTC',
    automaticTrading: false
  });
});

app.get('/api/status', requireTelegram, (req, res) => {
  resetDailyCounterIfNeeded();

  const quota = quotaState();

  res.json({
    ok: true,
    apiConfigured: Boolean(API_KEY),
    status: quota.code,
    message: quota.message,
    dailyCalls,
    maxCallsPerDay: MAX_CALLS,
    remainingLocalCalls: Math.max(
      0,
      MAX_CALLS - dailyCalls
    ),
    quotaDateUTC: quotaDate,
    globalFetchGapMs: GLOBAL_FETCH_GAP_MS,
    lastProviderCallAt: lastProviderCallAt || null,
    lastSuccessfulRequestAt,
    lastApiError,
    providerBlockedUntil:
      providerBlockedUntil > Date.now()
        ? providerBlockedUntil
        : null,
    cachedSymbols: [...cache.keys()],
    queuedOrRunningSymbols: [...inFlight.keys()]
  });
});

app.get('/api/market', requireTelegram, async (req, res) => {
  const symbol = String(
    req.query.symbol || 'EURUSD'
  ).toUpperCase();

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
  } catch {
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
    message:
      'ประวัตินี้เก็บในหน่วยความจำและจะหายเมื่อเซิร์ฟเวอร์เริ่มใหม่'
  });
});

// =====================================================
// 13. MINI APP FALLBACK AND SERVER START
// =====================================================

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
  console.log(
    `Telegram authentication: ${REQUIRE_AUTH ? 'ON' : 'OFF'}`
  );
  console.log('Market source: Twelve Data Forex Non-OTC');
  console.log(`Minimum signal score: ${MIN_SCORE}`);
  console.log(`Provider request gap: ${GLOBAL_FETCH_GAP_MS}ms`);
});
