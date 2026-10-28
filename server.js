
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
  1, Number(process.env.MAX_API_CALLS_PER_DAY || 700)
);
const MIN_SCORE = Math.min(
  90, Math.max(40, Number(process.env.MIN_SIGNAL_SCORE || 68))
);
const HOLD_SECONDS = Math.max(
  5, Math.min(120, Number(process.env.SIGNAL_HOLD_SECONDS || 40))
);

const CACHE_MS = 15000;
const GLOBAL_FETCH_GAP_MS = 12000;
const MAX_CANDLE_CLOSE_AGE_MS = 75000;
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
      message: 'ถึงเพดาน API ที่ตั้งไว้ในแอปแล้ว'
    };
  }

  if (Date.now() < providerBlockedUntil) {
    return {
      ok: false,
      code: 'API_LIMIT',
      message: providerBlockReason
    };
  }

  if (Date.now() - lastProviderCallAt < GLOBAL_FETCH_GAP_MS) {
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
      message: 'กรุณาเปิด Mini App ผ่านปุ่มใน Telegram'
    });
  }

  next();
}

function parseCandleTime(value) {
  const text = String(value || '');
  const normalized =
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(text)
      ? text
      : `${text.replace(' ', 'T')}Z`;

  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeCandles(values) {
  const now = Date.now();
  const sorted = (values || [])
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
    .sort((a, b) => a.time - b.time);

  const result = [];

  for (const c of sorted) {
    if (!result.length || c.time > result[result.length - 1].time) {
      result.push(c);
    }
  }

  return result;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let value = values.slice(0, period)
    .reduce((sum, n) => sum + n, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gain = 0;
  let loss = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }

  const avgGain = gain / period;
  const avgLoss = loss / period;

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    ranges.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  const values = ranges.slice(-period);
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function analyze(candles) {
  if (candles.length < 60) {
    return {
      signal: 'STANDBY',
      score: 0,
      reason: 'ข้อมูลไม่ครบ 60 แท่ง',
      indicators: {}
    };
  }

  const closes = candles.map(c => c.close);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const rv = rsi(closes, 14);
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macd = fast - slow;
  const av = atr(candles, 14);

  if ([e8, e21, e50, rv, macd, av].some(v => !Number.isFinite(v))) {
    return {
      signal: 'STANDBY',
      score: 0,
      reason: 'คำนวณตัวชี้วัดไม่ครบ',
      indicators: {}
    };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const range = Math.max(last.high - last.low, 1e-10);
  const bodyRatio = Math.abs(last.close - last.open) / range;
  const momentum = closes.at(-1) - closes.at(-4);

  let call = 0;
  let put = 0;
  const reasons = [];

  if (e8 > e21 && e21 > e50) {
    call += 30;
    reasons.push('EMA ขาขึ้น');
  } else if (e8 < e21 && e21 < e50) {
    put += 30;
    reasons.push('EMA ขาลง');
  }

  if (macd > 0) call += 15;
  else if (macd < 0) put += 15;

  if (rv >= 52 && rv <= 68) call += 15;
  else if (rv <= 48 && rv >= 32) put += 15;

  if (momentum > 0) call += 15;
  else if (momentum < 0) put += 15;

  if (last.close > last.open && bodyRatio >= 0.45) call += 10;
  else if (last.close < last.open && bodyRatio >= 0.45) put += 10;

  if (last.close > prev.close) call += 5;
  else if (last.close < prev.close) put += 5;

  // RSI สุดโต่ง: หลีกเลี่ยงการไล่ราคาที่อาจกลับตัว
  if (rv > 72) call = Math.min(call, 45);
  if (rv < 28) put = Math.min(put, 45);

  let signal = 'STANDBY';
  let score = Math.max(call, put);

  if (call >= MIN_SCORE && call > put + 10) {
    signal = 'CALL';
    score = call;
  } else if (put >= MIN_SCORE && put > call + 10) {
    signal = 'PUT';
    score = put;
  }

  if (av <= 0) {
    signal = 'STANDBY';
    score = 0;
  }

  return {
    signal,
    score: Math.min(100, Math.round(score)),
    reason: reasons.join(' · ') || 'ทิศทางยังไม่ชัดเจน',
    indicators: {
      ema8: e8,
      ema21: e21,
      ema50: e50,
      rsi: rv,
      macd,
      atr: av,
      bodyRatio
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
    dataAgeSeconds: previous?.candleCloseTime
      ? Math.max(0, Math.floor(
          (Date.now() - Date.parse(previous.candleCloseTime)) / 1000
        ))
      : null,
    signal: 'STANDBY',
    score: 0,
    reason: 'ข้อมูลไม่พร้อม — หยุดสัญญาณใหม่',
    indicators: previous?.indicators ?? {},
    candles: previous?.candles ?? []
  };
}

function checkCached(symbol) {
  const previous = cache.get(symbol);
  if (!previous) return null;

  const closeMs = Date.parse(previous.candleCloseTime);
  const ageMs = Date.now() - closeMs;

  if (!Number.isFinite(closeMs) || ageMs < 0 ||
      ageMs > MAX_CANDLE_CLOSE_AGE_MS) {
    return unavailable(
      symbol,
      'DATA_STALE',
      'ข้อมูลแท่งเทียนเกินอายุที่อนุญาต',
      previous
    );
  }

  return {
    ...previous,
    dataAgeSeconds: Math.floor(ageMs / 1000),
    dataFresh: true
  };
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

      const body = await response.json();

      if (!response.ok || body.status === 'error' || body.code) {
        const message = body.message || `HTTP ${response.status}`;

        if (isQuotaError(message, response.status)) {
          providerBlockedUntil = Date.now() + PROVIDER_COOLDOWN_MS;
          providerBlockReason =
            'ผู้ให้บริการจำกัดโควต้าหรือความถี่ พัก API ชั่วคราว';
        }

        throw new Error(message);
      }

      const candles = normalizeCandles(body.values);

      if (candles.length < 60) {
        throw new Error('มีแท่งเทียนที่ปิดแล้วไม่ถึง 60 แท่ง');
      }

      const last = candles[candles.length - 1];
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
      lastApiError = '';
      lastSuccessfulRequestAt = Date.now();

      return data;
    } catch (error) {
      lastApiError = String(error.message || 'API request failed');

      const code = isQuotaError(lastApiError, 0)
        ? 'API_LIMIT'
        : 'DATA_STALE';

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
    minimumScore: MIN_SCORE,
    signalHoldSeconds: HOLD_SECONDS,
    prepareBeepSeconds: 10,
    entrySignalSeconds: 5,
    maxCallsPerDay: MAX_CALLS
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
      providerBlockedUntil > Date.now() ? providerBlockedUntil : null
  });
});

app.get('/api/market', requireTelegram, async (req, res) => {
  const symbol = String(req.query.symbol || 'EURUSD').toUpperCase();

  if (!Object.hasOwn(SYMBOLS, symbol)) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_SYMBOL',
      message: 'ไม่รองรับคู่เงินนี้'
    });
  }

  const result = await fetchMarket(symbol);
  res.status(200).json(result);
});

app.get('/api/signals/history', requireTelegram, (req, res) => {
  res.json({
    ok: true,
    items: [],
    message: 'ยังไม่มีประวัติผลการเทรดที่บันทึกไว้'
  });
});

// Express 5 compatible catch-all
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, code: 'NOT_FOUND' });
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
});
