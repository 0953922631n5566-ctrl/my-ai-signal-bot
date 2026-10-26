import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(root, "public")));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.TWELVEDATA_API_KEY || "demo";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
const APP_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const ALLOWLIST = (process.env.ALLOWED_TELEGRAM_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SYMBOLS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "USD/CHF",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY"
];

// --- ตั้งค่า Cache และ Auto Scanner ---
const cache = new Map();
const CACHE_MS = 60000;          // แคช 60 วินาที ลดภาระ API
const SCAN_INTERVAL_MS = 8000;   // รอบสแกนอัตโนมัติทุก 8 วินาทีต่อคู่
const scanResults = new Map();

let scannerRunning = false;
let lastScanTime = null;
let scannerError = null;
let currentScanSymbol = null;

// --- API Endpoints ---
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    dataKeyConfigured: Boolean(API_KEY && API_KEY !== "demo"),
    telegramConfigured: Boolean(BOT_TOKEN && APP_URL),
    scannerRunning,
    scannerError,
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    symbols: SYMBOLS,
    timeframe: "1min",
    mode: "auto-scan",
    autoScan: true,
    scannerRunning,
    currentScanSymbol,
    lastScanTime,
    dataProvider: "Twelve Data"
  });
});

// Endpoint สำหรับดึงผลสแกนทั้งหมด
app.get("/api/scan", auth, (_req, res) => {
  const results = SYMBOLS.map((symbol) => {
    const item = scanResults.get(symbol);

    return item || {
      symbol,
      analysis: {
        signal: "WAIT",
        score: 0,
        reasons: ["กำลังรอสแกน"]
      },
      scannedAt: null,
      error: null
    };
  });

  res.json({
    ok: true,
    mode: "auto-scan",
    timeframe: "1min",
    provider: "Twelve Data",
    scannerRunning,
    currentScanSymbol,
    lastScanTime,
    scannerError,
    selected: getBestSignal(),
    totalSymbols: SYMBOLS.length,
    scannedSymbols: results.filter(
      (item) => item.scannedAt !== null && !item.stale
    ).length,
    results
  });
});

// Endpoint สำหรับกดรีเฟรชผลสแกนด้วยตัวเอง
app.post("/api/scan/refresh", auth, async (_req, res) => {
  try {
    const symbol = [...SYMBOLS].sort((a, b) => {
      const ta = scanResults.get(a)?.scannedAt || 0;
      const tb = scanResults.get(b)?.scannedAt || 0;
      return ta - tb;
    })[0];

    const result = await scanOneSymbol(symbol);
    lastScanTime = Date.now();

    res.json({
      ok: true,
      refreshed: symbol,
      result,
      selected: getBestSignal()
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message || "Scan failed"
    });
  }
});

// --- Telegram Auth ---
function verifyTelegram(initData) {
  if (!BOT_TOKEN) return { ok: true, user: { name: "Guest" } };
  if (!initData) return { ok: true, user: { name: "WebUser" } };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: true, user: { name: "Guest" } };

    params.delete("hash");

    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secret = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const expected = crypto
      .createHmac("sha256", secret)
      .update(checkString)
      .digest("hex");

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(hash, "hex");

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: "Invalid Telegram signature" };
    }

    const authDate = Number(params.get("auth_date") || 0);
    if (!authDate || Date.now() / 1000 - authDate > 86400) {
      return { ok: false, error: "Telegram session expired" };
    }

    const user = JSON.parse(params.get("user") || "{}");

    if (ALLOWLIST.length && !ALLOWLIST.includes(String(user.id))) {
      return { ok: false, error: "User not allowed" };
    }

    return { ok: true, user };
  } catch {
    return { ok: true, user: { name: "FallbackUser" } };
  }
}

function auth(req, res, next) {
  const initData = req.get("x-telegram-init-data") || "";
  const result = verifyTelegram(initData);
  if (!result.ok) return res.status(401).json(result);
  req.telegramUser = result.user;
  next();
}

// --- Market Data & Analysis ---
async function getCandles(symbol) {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.candles;
  }

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000)
  });

  const json = await response.json();

  if (!response.ok || json.status === "error" || !Array.isArray(json.values)) {
    throw new Error(json.message || "Market data unavailable from Twelve Data");
  }

  const candles = json.values
    .map((c) => ({
      time: Date.parse(c.datetime.replace(" ", "T") + "Z"),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        [c.open, c.high, c.low, c.close].every(Number.isFinite)
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 30) {
    throw new Error("Waiting for sufficient market history");
  }

  cache.set(symbol, { at: Date.now(), candles });
  return candles;
}

function ema(values, period) {
  if (values.length < period) return Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let value =
    values.slice(0, period).reduce((sum, n) => sum + n, 0) / period;

  const out = Array(period - 1).fill(null);
  out.push(value);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    out.push(value);
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0,
    losses = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function analyze(allCandles) {
  const candles = allCandles;
  if (candles.length < 30) {
    throw new Error("Not enough candle data for analysis");
  }

  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes.slice(-60), 14);
  const current = candles[last];
  const previous = candles[last - 1] || current;

  const trendUp = e9[last] > e21[last] && e21[last] > e50[last];
  const trendDown = e9[last] < e21[last] && e21[last] < e50[last];

  const range = Math.max(current.high - current.low, 1e-10);
  const body = (current.close - current.open) / range;

  let call = 0;
  let put = 0;
  const reasons = [];

  if (trendUp) {
    call += 2;
    reasons.push("EMA Bullish Alignment");
  }
  if (trendDown) {
    put += 2;
    reasons.push("EMA Bearish Alignment");
  }

  if (r >= 52 && r <= 68) {
    call++;
    reasons.push("RSI Bullish Momentum");
  }
  if (r <= 48 && r >= 32) {
    put++;
    reasons.push("RSI Bearish Momentum");
  }

  if (current.close > previous.close) call++;
  if (current.close < previous.close) put++;
  if (body > 0.35) call++;
  if (body < -0.35) put++;

  let signal = "WAIT";

  if (trendUp && call >= 3 && call - put >= 1 && r < 70) {
    signal = "CALL";
  }

  if (trendDown && put >= 3 && put - call >= 1 && r > 30) {
    signal = "PUT";
  }

  const score = Math.min(100, Math.round((Math.max(call, put) / 5) * 100));

  return {
    signal,
    score,
    callScore: call,
    putScore: put,
    rsi: Number(r.toFixed(1)),
    close: current.close,
    candleTime: current.time,
    ema9: e9[last],
    ema21: e21[last],
    ema50: e50[last],
    reasons: reasons.length ? reasons : ["ตลาดยังไม่เข้าเกณฑ์ชัดเจน"],
    sampleSize: candles.length
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getBestSignal() {
  const results = [...scanResults.values()]
    .sort((a, b) => b.analysis.score - a.analysis.score);

  const candidates = results.filter((item) =>
    ["CALL", "PUT"].includes(item.analysis.signal) &&
    item.analysis.score >= 60
  );

  if (!candidates.length) {
    return {
      symbol: null,
      signal: "WAIT",
      score: 0,
      message: "ยังไม่มีคู่เงินที่ผ่านเกณฑ์"
    };
  }

  const best = candidates[0];

  return {
    symbol: best.symbol,
    signal: best.analysis.signal,
    score: best.analysis.score,
    close: best.analysis.close,
    candleTime: best.analysis.candleTime,
    message: "คู่เงินที่ได้คะแนนสูงสุดจากผลสแกนล่าสุด"
  };
}

async function scanOneSymbol(symbol) {
  try {
    const candles = await getCandles(symbol);
    const analysis = analyze(candles);

    const result = {
      symbol,
      analysis,
      scannedAt: Date.now(),
      error: null,
      stale: false
    };

    scanResults.set(symbol, result);
    return result;
  } catch (error) {
    const old = scanResults.get(symbol);

    if (old) {
      scanResults.set(symbol, {
        ...old,
        error: error.message,
        stale: true
      });
    } else {
      scanResults.set(symbol, {
        symbol,
        analysis: {
          signal: "WAIT",
          score: 0,
          reasons: ["ดึงข้อมูลราคาไม่สำเร็จ"]
        },
        scannedAt: Date.now(),
        error: error.message,
        stale: true
      });
    }

    return scanResults.get(symbol);
  }
}

async function startAutoScanner() {
  if (scannerRunning) return;
  scannerRunning = true;
  scannerError = null;

  while (scannerRunning) {
    for (const symbol of SYMBOLS) {
      if (!scannerRunning) break;
      currentScanSymbol = symbol;
      await scanOneSymbol(symbol);
      lastScanTime = Date.now();
      await sleep(SCAN_INTERVAL_MS);
    }
  }
}

// --- Market Endpoint ---
app.get("/api/market", auth, async (req, res) => {
  const symbol = String(req.query.symbol || "EUR/USD").toUpperCase();

  if (!SYMBOLS.includes(symbol)) {
    return res.status(400).json({ ok: false, error: "Unsupported symbol" });
  }

  const cachedResult = scanResults.get(symbol);
  if (cachedResult && !cachedResult.stale) {
    return res.json({
      ok: true,
      symbol,
      provider: "Twelve Data",
      fetchedAt: cachedResult.scannedAt,
      analysis: cachedResult.analysis,
      candles: []
    });
  }

  try {
    const candles = await getCandles(symbol);
    const analysis = analyze(candles);

    res.json({
      ok: true,
      symbol,
      provider: "Twelve Data",
      fetchedAt: Date.now(),
      analysis,
      candles: candles.slice(-60)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message || "Market data unavailable"
    });
  }
});

app.post("/api/telegram/setup", async (_req, res) => {
  if (!BOT_TOKEN || !BOT_USERNAME || !APP_URL) {
    return res.status(400).json({
      ok: false,
      error: "Configure bot token, username and app URL first"
    });
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          menu_button: {
            type: "web_app",
            text: "Open AI Radar",
            web_app: { url: APP_URL }
          }
        })
      }
    );

    const result = await response.json();
    res.status(response.ok && result.ok ? 200 : 502).json(result);
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get("/api/telegram/link", (_req, res) => {
  if (!BOT_USERNAME) {
    return res.status(400).json({ ok: false, error: "Bot username missing" });
  }

  res.json({
    ok: true,
    url: `https://t.me/${BOT_USERNAME}?startapp=radar`
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(root, "public", "index.html"));
});

// เปิดเซิร์ฟเวอร์เพียงจุดเดียว พร้อมระบบดักจับ Error
app.listen(PORT, () => {
  console.log(`Market AI Radar listening on port ${PORT}`);

  startAutoScanner().catch((error) => {
    scannerError = error.message;
    scannerRunning = false;
    console.error("Auto scanner stopped:", error);
  });
});
