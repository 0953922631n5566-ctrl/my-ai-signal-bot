
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TWELVEDATA_API_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const DEFAULT_SYMBOL = process.env.DEFAULT_SYMBOL || "EUR/USD";
const CACHE_MS = Number(process.env.CACHE_MS || 110000);
const MAX_AGE_MS = Number(process.env.MAX_DATA_AGE_MS || 180000);

const SYMBOLS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
  "USD/CHF", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY"
];

const allowedIds = new Set(
  (process.env.ALLOWED_TELEGRAM_USER_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean)
);
const cache = new Map();

app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

function verifyTelegram(initData) {
  // ถ้าไม่ตั้ง BOT_TOKEN จะใช้โหมดทดสอบโดยไม่ตรวจ Telegram
  if (!BOT_TOKEN) return { ok: true, userId: null };

  if (!initData) return { ok: false, error: "กรุณาเปิดผ่าน Telegram Mini App" };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    const authDate = Number(params.get("auth_date"));

    if (!hash || !Number.isFinite(authDate)) {
      return { ok: false, error: "ข้อมูล Telegram ไม่ถูกต้อง" };
    }

    const age = Date.now() / 1000 - authDate;
    if (age > 86400 || age < -60) {
      return { ok: false, error: "ข้อมูล Telegram หมดอายุ กรุณาเปิด Mini App ใหม่" };
    }

    params.delete("hash");

    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secret = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculated = crypto
      .createHmac("sha256", secret)
      .update(checkString)
      .digest("hex");

    const a = Buffer.from(calculated, "hex");
    const b = Buffer.from(hash, "hex");

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: "ตรวจสอบ Telegram ไม่ผ่าน" };
    }

    let userId = null;
    try {
      userId = String(JSON.parse(params.get("user") || "{}").id || "");
    } catch {}

    if (allowedIds.size && !allowedIds.has(userId)) {
      return { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ใช้งาน" };
    }

    return { ok: true, userId };
  } catch {
    return { ok: false, error: "ไม่สามารถตรวจสอบ Telegram ได้" };
  }
}

function protect(req, res, next) {
  const auth = verifyTelegram(req.get("x-telegram-init-data") || "");
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  req.telegramUser = auth;
  next();
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / Math.max(losses, 0.000000001);
  return 100 - 100 / (1 + rs);
}

function analyze(values) {
  // Twelve Data returns newest candle first; reverse for analysis.
  const candles = [...values].reverse();
  const closes = candles.map(c => Number(c.close));
  if (closes.length < 55 || closes.some(v => !Number.isFinite(v))) {
    return { signal: "WAIT", score: 0, reason: "ข้อมูลแท่งเทียนไม่เพียงพอ" };
  }

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  let bull = 0, bear = 0;
  if (e9 > e21) bull++; else if (e9 < e21) bear++;
  if (e21 > e50) bull++; else if (e21 < e50) bear++;
  if (closes.at(-1) > e9) bull++; else if (closes.at(-1) < e9) bear++;
  if (r >= 52 && r < 70) bull++;
  else if (r <= 48 && r > 30) bear++;
  if (Number(last.close) > Number(last.open)) bull++;
  else if (Number(last.close) < Number(last.open)) bear++;
  if (Number(last.close) > Number(prev.close)) bull++;
  else if (Number(last.close) < Number(prev.close)) bear++;

  let signal = "WAIT";
  if (bull >= 4 && bull > bear) signal = "CALL";
  if (bear >= 4 && bear > bull) signal = "PUT";

  const score = signal === "WAIT"
    ? Math.min(59, 40 + Math.abs(bull - bear) * 5)
    : Math.min(85, 55 + Math.abs(bull - bear) * 5);

  return {
    signal,
    score,
    price: closes.at(-1),
    candleTime: last.datetime,
    rsi: Number(r.toFixed(2)),
    ema9: Number(e9.toFixed(6)),
    ema21: Number(e21.toFixed(6)),
    ema50: Number(e50.toFixed(6)),
    reason: signal === "WAIT"
      ? "เงื่อนไขยังไม่สอดคล้องกัน"
      : `EMA + RSI + momentum (${bull}:${bear})`
  };
}

async function getMarket(symbol, force = false) {
  const old = cache.get(symbol);
  if (!force && old && Date.now() - old.fetchedAt < CACHE_MS) return old;

  if (!API_KEY || API_KEY.toLowerCase() === "demo") {
    throw new Error("ยังไม่ได้ตั้งค่า TWELVEDATA_API_KEY ใน Render");
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await response.json();

  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || `Twelve Data HTTP ${response.status}`);
  }

  const latest = data.values[0];
  const candleMs = Date.parse(String(latest.datetime).replace(" ", "T") + "Z");
  const result = {
    symbol,
    fetchedAt: Date.now(),
    latestAgeMs: Number.isFinite(candleMs) ? Math.max(0, Date.now() - candleMs) : null,
    values: data.values,
    analysis: analyze(data.values)
  };

  cache.set(symbol, result);
  return result;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "neural-radar-ai",
    time: new Date().toISOString(),
    marketApiConfigured: Boolean(API_KEY),
    telegramAuthEnabled: Boolean(BOT_TOKEN)
  });
});

app.get("/api/status", protect, (_req, res) => {
  res.json({
    ok: true,
    scannerRunning: true,
    cachedPairs: cache.size,
    symbols: SYMBOLS,
    time: new Date().toISOString()
  });
});

app.get("/api/symbols", protect, (_req, res) => {
  res.json({ ok: true, symbols: SYMBOLS });
});

app.get("/api/scan", protect, async (req, res) => {
  const symbol = String(req.query.symbol || DEFAULT_SYMBOL).toUpperCase();
  if (!SYMBOLS.includes(symbol)) {
    return res.status(400).json({ ok: false, error: "ไม่รองรับคู่เงินนี้" });
  }

  try {
    const result = await getMarket(symbol, req.query.refresh === "1");
    const stale = result.latestAgeMs !== null && result.latestAgeMs > MAX_AGE_MS;
    const a = stale
      ? { signal: "WAIT", score: 0, reason: "ข้อมูลราคาเก่าเกินเกณฑ์" }
      : result.analysis;

    res.json({
      ok: true,
      symbol,
      pair: symbol,
      signal: a.signal,
      score: a.score,
      price: a.price ?? result.analysis.price,
      candleTime: result.analysis.candleTime,
      fetchedAt: new Date(result.fetchedAt).toISOString(),
      dataAgeMs: result.latestAgeMs,
      stale,
      reason: a.reason,
      indicators: {
        rsi: result.analysis.rsi,
        ema9: result.analysis.ema9,
        ema21: result.analysis.ema21,
        ema50: result.analysis.ema50
      }
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "ดึงข้อมูลตลาดไม่สำเร็จ" });
  }
});

app.get("/api/scan/all", protect, (_req, res) => {
  const results = SYMBOLS.map(symbol => {
    const c = cache.get(symbol);
    if (!c) return {
      symbol, pair: symbol, signal: "WAIT", score: 0,
      stale: true, reason: "ยังไม่มีข้อมูลแคช"
    };

    const stale = c.latestAgeMs !== null && c.latestAgeMs > MAX_AGE_MS;
    return {
      symbol, pair: symbol,
      signal: stale ? "WAIT" : c.analysis.signal,
      score: stale ? 0 : c.analysis.score,
      price: c.analysis.price,
      stale,
      fetchedAt: new Date(c.fetchedAt).toISOString(),
      reason: stale ? "ข้อมูลราคาเก่า" : c.analysis.reason
    };
  });

  const bestSignal = results
    .filter(x => !x.stale && x.signal !== "WAIT")
    .sort((a, b) => b.score - a.score)[0] || null;

  res.json({ ok: true, results, bestSignal });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Neural Radar AI listening on port ${PORT}`);
  console.log(`Twelve Data key configured: ${Boolean(API_KEY)}`);
});
