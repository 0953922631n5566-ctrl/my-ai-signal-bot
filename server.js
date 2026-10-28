
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const REQUIRE_AUTH =
  String(process.env.REQUIRE_TELEGRAM_AUTH || 'true') === 'true';

const MAX_CALLS = Math.max(
  1,
  Number(process.env.MAX_API_CALLS_PER_DAY || 700)
);

const MIN_SCORE = Math.min(
  90,
  Math.max(40, Number(process.env.MIN_SIGNAL_SCORE || 68))
);

const HOLD_SECONDS = Math.max(
  5,
  Math.min(120, Number(process.env.SIGNAL_HOLD_SECONDS || 40))
);

const CACHE_MS = 55000;
const GLOBAL_FETCH_GAP_MS = 12000;
const MAX_CANDLE_AGE_MS = 150000;
const PROVIDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const SYMBOLS = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  AUDUSD: 'AUD/USD',
  USDCAD: 'USD/CAD'
};

let dailyCalls = 0;
let quotaDate = utcDate();
let lastProviderCallAt = 0;
let providerBlockedUntil = 0;
let providerBlockReason = '';
let lastApiError = '';
let lastSuccessfulRequestAt = null;

const cache = new Map();
const inFlight = new Map();

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

  const now = Date.now();

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
      message: 'ถึงเพดาน API ที่ตั้งไว้แล้ว'
    };
  }

  if (now < providerBlockedUntil) {
    return {
      ok: false,
      code: 'API_LIMIT',
      message: providerBlockReason || 'API ถูกพักชั่วคราว'
    };
  }

  if (now - lastProviderCallAt < GLOBAL_FETCH_GAP_MS) {
    return {
      ok: false,
      code: 'WAITING',
      message: 'กำลังจำกัดความถี่การเรียก API'
    };
  }

  return { ok: true, code: 'OK', message: 'พร้อมดึงข้อมูล' };
}

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

    if (!Number.isFinite(authDate) ||
        authDate > nowSeconds + 30 ||
        nowSeconds - authDate > 86400) {
      return false;
    }

    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest();

    const receivedHash = Buffer.from(hash, 'hex');

    return receivedHash.length === calculatedHash.length &&
      crypto.timingSafeEqual(receivedHash, calculatedHash);
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
  // Twelve Data is requested with timezone=UTC.
  // Treat its timestamp as UTC when no timezone suffix exists.
  const text = String(value || '');
  const normalized =
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(text)
      ? text
      : `${text.replace(' ', 'T')}Z`;

  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : NaN;
}

function normalizeCandles(values) {
  const now = Date.now();

  return (values || [])
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
      Number.isFinite(c.close)
    )
    .filter(c => c.time + 60000 <= now)
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time > arr[i - 1].time);
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let result = values.slice(0, period)
    .reduce((sum, n) => sum + n, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    ranges.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    ));
  }

  const selected = ranges.slice(-period);
  return selected.reduce((sum, n) => sum + n, 0) / selected.length;
}

function analyze(candles) {
  if (candles.length < 60) {
    return {
      signal: 'STANDBY',
      score: 0,
      reason: 'ข้อมูลแท่งเทียนไม่เพียงพอ',
      indicators: {}
    };
  }

  const closes = candles.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const macdFast = ema(closes, 12);
  const macdSlow = ema(closes, 26);
  const macd = macdFast !== null && macdSlow !== null
    ? macdFast - macdSlow
    : null;
  const atr = calculateATR(candles, 14);

  if ([e8, e21, e50, rsi, macd, atr].some(v => v === null)) {
    return {
      signal: 'STANDBY',
      score: 0,
      reason: 'คำนวณตัวชี้วัดไม่ครบ',
      indicators: {}
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const candleRange = Math.max(last.high - last.low, 1e-10);
  const bodyRatio = Math.abs(last.close - last.open) / candleRange;
  const momentum = last.close - closes[closes.length - 4];

  let call = 0;
  let put = 0;
  const reasons = [];

  if (e8 > e21 && e21 > e50) {
    call += 30;
    reasons.push('EMA เรียงตัวขาขึ้น');
  } else if (e8 < e21 && e21 < e50) {
    put += 30;
    reasons.push('EMA เรียงตัวขาลง');
  }

  if (macd > 0) call += 15;
  if (macd < 0) put += 15;

  if (rsi >= 52 && rsi <= 68) call += 15;
  if (rsi <= 48 && rsi >= 32) put += 15;

  if (momentum > 0) call += 15;
  if (momentum < 0) put += 15;

  if (last.close > last.open && bodyRatio >= 0.45) call += 10;
  if (last.close < last.open && bodyRatio >= 0.45) put += 10;

  if (last.close > previous.close) call += 5;
  if (last.close < previous.close) put += 5;

  // Avoid extreme overbought/oversold entries.
  if (rsi > 72) call = Math.min(call, 45);
  if (rsi < 28) put = Math.min(put, 45);

  let signal = 'STANDBY';
  let score = Math.max(call, put);

  if (call >= MIN_SCORE && call > put + 10) {
    signal = 'CALL';
    score = call;
  } else if (put >= MIN_SCORE && put > call + 10) {
    signal = 'PUT';
    score = put;
  }

  if (atr <= 0) {
    signal = 'STANDBY';
    score = 0;
  }

  return {
    signal,
    score: Math.min(100, Math.round(score)),
    reason: reasons.join(' · ') || 'เงื่อนไขยังไม่ชัดเจน',
    indicators: {
      ema8: e8,
      ema21: e21,
      ema50: e50,
      rsi,
      macd,
      atr,
      bodyRatio
    }
  };
}

function classifyProviderError(message, httpStatus) {
  const text = String(message || '').toLowerCase();

  return httpStatus === 429 ||
    text.includes('api credits') ||
    text.includes('credit') ||
    text.includes('rate limit') ||
    text.includes('run out') ||
    text.includes('limit exceeded') ||
    text.includes('quota');
}

async function fetchMarket(symbol) {
  resetDailyCounterIfNeeded();

  const cached = cache.get(symbol);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_MS) {
    return cached;
  }

  if (inFlight.has(symbol)) {
    return inFlight.get(symbol);
  }

  const quota = quotaState();

  if (!quota.ok) {
    return makeUnavailable(symbol, quota.code, quota.message, cached);
  }

  const promise = (async () => {
    try {
      const url = new URL('https://api.twelvedata.com/time_series');
      url.searchParams.set('symbol', SYMBOLS[symbol]);
      url.searchParams.set('interval', '1min');
      url.searchParams.set('outputsize', '100');
      url.searchParams.set('timezone', 'UTC');
      url.searchParams.set('apikey', API_KEY);

      lastProviderCallAt = Date.now();
      dailyCalls += 1;

      const response = await fetch(url, {
        signal: AbortSignal.timeout(12000)
      });

      let body;

      try {
        body = await response.json();
      } catch {
        throw new Error('API ตอบกลับไม่ใช่ JSON');
      }

      if (!response.ok || body.status === 'error' || body.code) {
        const message = body.message || `HTTP ${response.status}`;

        if (classifyProviderError(message, response.status)) {
          providerBlockedUntil = Date.now() + PROVIDER_COOLDOWN_MS;
          providerBlockReason =
            'Twelve Data จำกัดโควต้าหรือความถี่ พักการเรียก API ชั่วคราว';
        }

        throw new Error(message);
      }

      const candles = normalizeCandles(body.values);

      if (candles.length < 60) {
        throw new Error('แท่งเทียนที่ปิดแล้วมีไม่ถึง 60 แท่ง');
      }

      const latest = candles[candles.length - 1];
      const ageMs = Date.now() - latest.time;

      if (ageMs < 0 || ageMs > MAX_CANDLE_AGE_MS) {
        throw new Error('ข้อมูลแท่งเทียนเก่าเกินเกณฑ์');
      }

      const analysis = analyze(candles);

      const result = {
        ok: true,
        code: 'OK',
        symbol,
        pair: SYMBOLS[symbol],
        price: latest.close,
        candleTime: new Date(latest.time).toISOString(),
        fetchedAt: Date.now(),
        dataAgeSeconds: Math.floor(ageMs / 1000),
        dataFresh: true,
        signal: analysis.signal,
        score: analysis.score,
        reason: analysis.reason,
        indicators: analysis.indicators,
        candles: candles.slice(-30).map(c => ({
          time: new Date(c.time).toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }))
      };

      cache.set(symbol, result);
      lastApiError = '';
      lastSuccessfulRequestAt = Date.now();

      return result;
    } catch (error) {
      lastApiError = String(error.message || 'API request failed');

      return makeUnavailable(
        symbol,
        classifyProviderError(lastApiError, 0) ? 'API_LIMIT' : 'DATA_STALE',
        lastApiError,
        cache.get(symbol)
      );
    } finally {
      inFlight.delete(symbol);
    }
  })();

  inFlight.set(symbol, promise);
  return promise;
}

function makeUnavailable(symbol, code, message, previous) {
  return {
    ok: false,
    code,
    message,
    symbol,
    pair: SYMBOLS[symbol] || symbol,
    dataFresh: false,
    price: previous?.price ?? null,
    candleTime: previous?.candleTime ?? null,
    fetchedAt: previous?.fetchedAt ?? null,
    dataAgeSeconds: previous?.candleTime
      ? Math.floor((Date.now() - Date.parse(previous.candleTime)) / 1000)
      : null,
    // Never allow a stale cached signal to be used as a new signal.
    signal: 'STANDBY',
    score: 0,
    reason: 'หยุดสัญญาณจนกว่าข้อมูลจะสด',
    indicators: previous?.indicators ?? {},
    candles: previous?.candles ?? []
  };
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
    minimumScore: MIN_SCORE,
    signalHoldSeconds: HOLD_SECONDS,
    prepareBeepSeconds: 10,
    entryBeepSeconds: 2,
    maxCallsPerDay: MAX_CALLS
  });
});

app.get('/api/status', requireTelegram, (req, res) => {
  resetDailyCounterIfNeeded();

  const quota = quotaState();
  const now = Date.now();

  res.json({
    ok: true,
    apiConfigured: Boolean(API_KEY),
    status: quota.code,
    message: quota.message,
    dailyCalls,
    maxCallsPerDay: MAX_CALLS,
    remainingLocalCalls: Math.max(0, MAX_CALLS - dailyCalls),
    quotaDateUTC: quotaDate,
    lastProviderCallAt: lastProviderCallAt || null,
    lastSuccessfulRequestAt,
    lastApiError,
    providerBlockedUntil:
      providerBlockedUntil > now ? providerBlockedUntil : null
  });
});

app.get('/api/market', requireTelegram, async (req, res) => {
  const symbol = String(req.query.symbol || 'EURUSD').toUpperCase();

  if (!Object.prototype.hasOwnProperty.call(SYMBOLS, symbol)) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_SYMBOL',
      message: 'ไม่รองรับคู่เงินนี้'
    });
  }

  const result = await fetchMarket(symbol);

  // A stale-data response is a service state, not a valid signal.
  res.status(200).json(result);
});

app.get('/api/signals/history', requireTelegram, (req, res) => {
  // No fake trade history: this endpoint intentionally reports no stored trades.
  res.json({
    ok: true,
    items: [],
    message: 'ยังไม่มีประวัติผลการเทรดที่บันทึกไว้'
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      code: 'NOT_FOUND'
    });
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) next(err);
  });
});

app.listen(PORT, () => {
  console.log(`AI Signal Radar running on port ${PORT}`);
  console.log(`Telegram authentication: ${REQUIRE_AUTH ? 'ON' : 'OFF'}`);
});
