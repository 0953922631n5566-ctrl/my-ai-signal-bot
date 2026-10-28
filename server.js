
'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const REQUIRE_TELEGRAM_AUTH =
  String(process.env.REQUIRE_TELEGRAM_AUTH || 'false') === 'true';

const THRESHOLD = clamp(Number(process.env.MIN_SIGNAL_SCORE || 68), 40, 95);
const HOLD_SECONDS = clamp(Number(process.env.SIGNAL_HOLD_SECONDS || 40), 5, 120);
const PREPARE_SECONDS = clamp(Number(process.env.PREPARE_BEEP_SECONDS || 10), 3, 30);
const ENTRY_SECONDS = clamp(Number(process.env.ENTRY_SIGNAL_SECONDS || 2), 1, 5);
const DAILY_LIMIT = clamp(Number(process.env.MAX_API_CALLS_PER_DAY || 800), 20, 100000);

const SYMBOLS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD',
  'USD/CAD', 'NZD/USD', 'USD/CHF', 'EUR/JPY',
  'GBP/JPY', 'EUR/GBP', 'EUR/CHF', 'AUD/JPY'
];

const cache = new Map();
const history = [];
const usage = { date: utcDate(), calls: 0 };
const CACHE_MS = 15000;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function dailyUsage() {
  if (usage.date !== utcDate()) {
    usage.date = utcDate();
    usage.calls = 0;
  }
  return usage;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Validate Telegram Web App initData using Telegram's HMAC method.
function validateTelegram(initData) {
  if (!BOT_TOKEN || !initData || initData.length > 8192) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return null;

  params.delete('hash');

  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(checkString)
    .digest('hex');

  if (!safeEqual(expectedHash, receivedHash)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  const age = Math.floor(Date.now() / 1000) - authDate;

  if (!authDate || age < -60 || age > 86400) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }

  return user?.id ? { id: String(user.id) } : null;
}

function requireUser(req, res, next) {
  if (!REQUIRE_TELEGRAM_AUTH) {
    req.user = { id: 'local-demo' };
    return next();
  }

  const initData = req.get('X-Telegram-Init-Data') || '';
  const user = validateTelegram(initData);

  if (!user) {
    return res.status(401).json({
      error: 'กรุณาเปิด Mini App จาก Telegram ที่ได้รับอนุญาต'
    });
  }

  req.user = user;
  next();
}

// Fetch real Forex reference candles from Twelve Data.
async function getCandles(symbol) {
  if (!API_KEY) {
    const error = new Error('ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บน Render');
    error.status = 503;
    throw error;
  }

  const now = Date.now();
  const cached = cache.get(symbol);

  if (cached && now - cached.fetchedAt < CACHE_MS) {
    return { ...cached, cached: true };
  }

  const counter = dailyUsage();

  if (counter.calls >= DAILY_LIMIT) {
    const error = new Error('ถึงขีดจำกัดความปลอดภัยของ API calls วันนี้แล้ว');
    error.status = 429;
    throw error;
  }

  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '1min');
  url.searchParams.set('outputsize', '120');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', API_KEY);

  counter.calls++;

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    const error = new Error(`Twelve Data HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }

  const body = await response.json();

  if (body.status === 'error' || !Array.isArray(body.values)) {
    const error = new Error(body.message || 'Twelve Data ไม่ส่งข้อมูลแท่งเทียนกลับมา');
    error.status = body.code === 429 ? 429 : 502;
    throw error;
  }

  const candles = body.values
    .map(item => ({
      time: item.datetime,
      timestamp: Date.parse(item.datetime.replace(' ', 'T') + 'Z'),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close)
    }))
    .filter(c =>
      Number.isFinite(c.timestamp) &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  // Exclude the currently forming candle.
  const currentMinute = Math.floor(now / 60000) * 60000;
  const completed = candles.filter(c => c.timestamp < currentMinute);

  if (completed.length < 55) {
    const error = new Error('ข้อมูลแท่งเทียนที่ปิดแล้วมีไม่เพียงพอ');
    error.status = 503;
    throw error;
  }

  const result = {
    candles: completed.slice(-120),
    fetchedAt: now,
    provider: 'Twelve Data',
    cached: false
  };

  cache.set(symbol, result);
  return result;
}

function ema(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  let current = values.slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  const output = Array(period - 1).fill(null);
  output.push(current);

  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    output.push(current);
  }

  return output;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }

  const recent = ranges.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  const line = values.map((_, index) =>
    fast[index] == null || slow[index] == null
      ? null
      : fast[index] - slow[index]
  );

  const valid = line.filter(value => value != null);
  if (valid.length < 9) {
    return { line: null, signal: null, histogram: null };
  }

  const signalLine = ema(valid, 9);
  const lastLine = valid.at(-1);
  const lastSignal = signalLine.at(-1);

  return {
    line: lastLine,
    signal: lastSignal,
    histogram: lastLine - lastSignal
  };
}

function analyze(candles) {
  const closes = candles.map(c => c.close);
  const last = candles.at(-1);
  const e8 = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes);
  const a = atr(candles);
  const m = macd(closes);

  let call = 0;
  let put = 0;
  let penalty = 0;
  const reasons = [];

  // Trend alignment
  if (e8.at(-1) > e21.at(-1) && e21.at(-1) > e50.at(-1)) {
    call += 24;
    reasons.push('EMA 8/21/50 เรียงตัวขึ้น');
  } else if (e8.at(-1) < e21.at(-1) && e21.at(-1) < e50.at(-1)) {
    put += 24;
    reasons.push('EMA 8/21/50 เรียงตัวลง');
  } else {
    reasons.push('แนวโน้ม EMA ยังไม่ชัด');
  }

  const momentumScale = a || last.close * 0.0001;
  const momentum = (closes.at(-1) - closes.at(-4)) / momentumScale;

  if (momentum > 0.25) {
    call += 12;
    reasons.push('Momentum เป็นบวก');
  } else if (momentum < -0.25) {
    put += 12;
    reasons.push('Momentum เป็นลบ');
  }

  if (m.histogram != null && m.histogram > 0) {
    call += 14;
    reasons.push('MACD histogram เป็นบวก');
  } else if (m.histogram != null && m.histogram < 0) {
    put += 14;
    reasons.push('MACD histogram เป็นลบ');
  }

  if (r != null && r >= 52 && r <= 68) {
    call += 12;
    reasons.push('RSI สนับสนุนแรงซื้อ');
  } else if (r != null && r <= 48 && r >= 32) {
    put += 12;
    reasons.push('RSI สนับสนุนแรงขาย');
  } else if (r > 70 || r < 30) {
    reasons.push('RSI สุดโต่ง: ระวังแรงย้อนกลับ');
  }

  const range = Math.max(last.high - last.low, Number.EPSILON);
  const bodyRatio = Math.abs(last.close - last.open) / range;

  if (last.close > last.open && bodyRatio > 0.55) {
    call += 10;
    reasons.push('แท่งปิดเขียวและ body ชัด');
  } else if (last.close < last.open && bodyRatio > 0.55) {
    put += 10;
    reasons.push('แท่งปิดแดงและ body ชัด');
  }

  const ranges = candles.slice(-30)
    .map(c => c.high - c.low)
    .sort((x, y) => x - y);

  const median = ranges[Math.floor(ranges.length / 2)] || 0;

  if (a && median && a < median * 0.55) {
    penalty += 12;
    reasons.push('ตลาดเงียบ: ลดคะแนน');
  }

  if (a && median && a > median * 2.5) {
    penalty += 18;
    reasons.push('ความผันผวนสูงผิดปกติ');
  }

  if (Date.now() - last.timestamp > 180000) {
    penalty += 25;
    reasons.push('ข้อมูลแท่งล่าสุดเก่าเกินไป');
  }

  call = clamp(call - penalty, 0, 100);
  put = clamp(put - penalty, 0, 100);

  const candidate = call > put ? 'CALL' : put > call ? 'PUT' : 'STANDBY';
  const score = candidate === 'CALL' ? call :
    candidate === 'PUT' ? put : Math.max(call, put);

  const fresh = Date.now() - last.timestamp <= 180000;
  const signal = fresh && score >= THRESHOLD &&
    Math.abs(call - put) >= 18 ? candidate : 'STANDBY';

  return {
    signal,
    candidate,
    score: Math.round(score),
    callScore: Math.round(call),
    putScore: Math.round(put),
    price: last.close,
    candleTime: last.time,
    candleTimestamp: last.timestamp,
    indicators: {
      ema8: e8.at(-1),
      ema21: e21.at(-1),
      ema50: e50.at(-1),
      rsi: r == null ? null : Number(r.toFixed(2)),
      macdHistogram: m.histogram == null ? null : Number(m.histogram.toPrecision(7)),
      atr: a == null ? null : Number(a.toPrecision(7))
    },
    reasons,
    riskPenalty: penalty,
    threshold: THRESHOLD,
    note: signal === 'STANDBY'
      ? 'เงื่อนไขยังไม่ผ่านเกณฑ์ รอจังหวะใหม่'
      : 'คะแนนเทคนิคผ่านเกณฑ์ แต่ไม่ได้รับประกันผลการเทรด'
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'AI Signal Radar',
    time: new Date().toISOString(),
    providerConfigured: Boolean(API_KEY)
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    symbols: SYMBOLS,
    timeframe: '1min',
    signalThreshold: THRESHOLD,
    holdSeconds: HOLD_SECONDS,
    prepareBeepSeconds: PREPARE_SECONDS,
    entrySignalSeconds: ENTRY_SECONDS,
    source: 'Twelve Data',
    authRequired: REQUIRE_TELEGRAM_AUTH
  });
});

app.get('/api/market', requireUser, async (req, res) => {
  const symbol = String(req.query.symbol || 'EUR/USD').toUpperCase();

  if (!SYMBOLS.includes(symbol)) {
    return res.status(400).json({ error: 'ไม่รองรับคู่เงินนี้' });
  }

  try {
    const result = await getCandles(symbol);
    const analysis = analyze(result.candles);
    const now = Date.now();
    const nextMinute = Math.floor(now / 60000) * 60000 + 60000;
    const countdown = Math.ceil((nextMinute - now) / 1000);
    const counter = dailyUsage();

    res.set('Cache-Control', 'no-store');
    res.json({
      symbol,
      timeframe: '1min',
      provider: result.provider,
      cached: result.cached,
      serverTime: now,
      lastFetchTime: result.fetchedAt,
      countdownSeconds: countdown,
      ...analysis,
      quota: {
        apiCallsToday: counter.calls,
        dailySafetyLimit: DAILY_LIMIT,
        remainingSafetyCalls: Math.max(0, DAILY_LIMIT - counter.calls)
      },
      candles: result.candles.slice(-30).map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.message || 'ดึงข้อมูลตลาดไม่สำเร็จ'
    });
  }
});

app.post('/api/signals/result', requireUser, (req, res) => {
  const { symbol, direction, result, entryPrice, exitPrice, score } = req.body || {};

  if (!SYMBOLS.includes(symbol) ||
      !['CALL', 'PUT'].includes(direction) ||
      !['WIN', 'LOSS', 'DRAW', 'UNSETTLED'].includes(result)) {
    return res.status(400).json({ error: 'ข้อมูลผลสัญญาณไม่ถูกต้อง' });
  }

  const row = {
    id: crypto.randomUUID(),
    userId: req.user.id,
    symbol,
    direction,
    result,
    entryPrice: Number.isFinite(Number(entryPrice)) ? Number(entryPrice) : null,
    exitPrice: Number.isFinite(Number(exitPrice)) ? Number(exitPrice) : null,
    score: Number.isFinite(Number(score)) ? Number(score) : null,
    recordedAt: new Date().toISOString()
  };

  history.unshift(row);
  if (history.length > 500) history.length = 500;

  res.status(201).json({
    ok: true,
    record: row,
    note: 'ประวัตินี้อยู่ในหน่วยความจำของเซิร์ฟเวอร์ และอาจหายเมื่อ Render รีสตาร์ต'
  });
});

app.get('/api/signals/history', requireUser, (req, res) => {
  const rows = history.filter(row => row.userId === req.user.id).slice(0, 100);
  const settled = rows.filter(row => ['WIN', 'LOSS', 'DRAW'].includes(row.result));
  const wins = settled.filter(row => row.result === 'WIN').length;

  res.json({
    rows,
    stats: {
      total: settled.length,
      wins,
      losses: settled.filter(row => row.result === 'LOSS').length,
      draws: settled.filter(row => row.result === 'DRAW').length,
      winRate: settled.length ? Math.round(wins / settled.length * 1000) / 10 : null
    }
  });
});

app.listen(PORT, () => {
  console.log(`AI Signal Radar listening on port ${PORT}`);
  if (!API_KEY) console.warn('TWELVE_DATA_API_KEY is not configured.');
});
