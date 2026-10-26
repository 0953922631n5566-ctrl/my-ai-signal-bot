
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

// คู่เงิน Forex ตลาดหลัก ไม่รวม OTC
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

// ตั้งค่าการสแกน
const CACHE_MS = 12000;
const SCAN_INTERVAL_MS = 8000;
const MAX_SIGNAL_AGE_MS = 180000;
const MIN_SIGNAL_SCORE = 60;

const cache = new Map();
const scanResults = new Map();

let scannerRunning = false;
let scannerBusy = false;
let currentScanSymbol = null;
let lastScanTime = null;
let scannerError = null;
let lastFullScanTime = null;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    dataKeyConfigured: Boolean(API_KEY && API_KEY !== "demo"),
    telegramConfigured: Boolean(BOT_TOKEN && APP_URL),
    scannerRunning,
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    symbols: SYMBOLS,
    timeframe: "1min",
    mode: "signal-only",
    autoScan: true,
    scannerRunning,
    scannerBusy,
    currentScanSymbol,
    lastScanTime,
    lastFullScanTime,
    scannerError,
    dataProvider: "Twelve Data"
  });
});

// ตรวจสอบ Telegram Mini App
function verifyTelegram(initData) {
  if (!BOT_TOKEN) {
    return { ok: true, user: { name: "Guest" } };
  }

  if (!initData) {
    return { ok: true, user: { name: "WebUser" } };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) {
      return { ok: false, error: "Missing Telegram signature" };
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
    const age = Date.now() / 1000 - authDate;

    if (!authDate || age < 0 || age > 86400) {
      return { ok: false, error: "Telegram session expired" };
    }

    const user = JSON.parse(params.get("user") || "{}");

    if (ALLOWLIST.length && !ALLOWLIST.includes(String(user.id))) {
      return { ok: false, error: "User not allowed" };
    }

    return { ok: true, user };
  } catch {
    return { ok: false, error: "Telegram authentication failed" };
  }
}

function auth(req, res, next) {
  const initData = req.get("x-telegram-init-data") || "";
  const result = verifyTelegram(initData);

  if (!result.ok) {
    return res.status(401).json(result);
  }

  req.telegramUser = result.user;
  next();
}

// ดึงแท่งเทียนจาก Twelve Data พร้อมแคช
async function getCandles(symbol) {
  const cached = cache.get(symbol);

  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.candles;
  }

  if (!API_KEY || API_KEY === "demo") {
    throw new Error("กรุณาตั้งค่า TWELVEDATA_API_KEY ใน Render");
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
    .filter((c) =>
      Number.isFinite(c.time) &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 50) {
    throw new Error("Waiting for sufficient market history");
  }

  cache.set(symbol, { at: Date.now(), candles });
  return candles;
}

function ema(values, period) {
  if (values.length < period) {
    return Array(values.length).fill(null);
  }

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

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];

    if (d > 0) gains += d;
    else losses -= d;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(d, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  return 100 - 100 / (1 + avgGain / avgLoss);
}

// วิเคราะห์แนวโน้มด้วย EMA และ RSI
function analyze(allCandles) {
  if (allCandles.length < 50) {
    throw new Error("Not enough candle data for analysis");
  }

  const candles = allCandles;
  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes.slice(-60), 14);

  const current = candles[last];
  const previous = candles[last - 1] || current;

  const trendUp =
    e9[last] > e21[last] && e21[last] > e50[last];

  const trendDown =
    e9[last] < e21[last] && e21[last] < e50[last];

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
  } else if (
    trendDown &&
    put >= 3 &&
    put - call >= 1 &&
    r > 30
  ) {
    signal = "PUT";
  }

  const score = Math.min(
    100,
    Math.round((Math.max(call, put) / 5) * 100)
  );

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
    reasons: reasons.length
      ? reasons
      : ["ตลาดยังไม่เข้าเกณฑ์ชัดเจน"],
    sampleSize: candles.length
  };
}

// สแกนคู่เงินหนึ่งคู่
async function scanOneSymbol(symbol) {
  try {
    const candles = await getCandles(symbol);
    const analysis = analyze(candles);

    const result = {
      symbol,
      analysis,
      scannedAt: Date.now(),
      candleTime: analysis.candleTime,
      stale: false,
      error: null
    };

    scanResults.set(symbol, result);
    return result;
  } catch (error) {
    const old = scanResults.get(symbol);

    if (old) {
      scanResults.set(symbol, {
        ...old,
        stale: true,
        error: error.message
      });
    } else {
      scanResults.set(symbol, {
        symbol,
        analysis: {
          signal: "WAIT",
          score: 0,
          reasons: ["ดึงข้อมูลราคาไม่สำเร็จ"]
        },
        scannedAt: null,
        candleTime: null,
        stale: true,
        error: error.message
      });
    }

    scannerError = `${symbol}: ${error.message}`;
    return scanResults.get(symbol);
  }
}

// เลือกสัญญาณที่เหมาะสมที่สุดจากผลสแกน
function getBestSignal() {
  const now = Date.now();

  const candidates = [...scanResults.values()]
    .filter((item) => {
      return (
        !item.stale &&
        item.scannedAt &&
        now - item.scannedAt <= MAX_SIGNAL_AGE_MS &&
        item.analysis &&
        ["CALL", "PUT"].includes(item.analysis.signal) &&
        item.analysis.score >= MIN_SIGNAL_SCORE
      );
    })
    .sort((a, b) => {
      // คะแนนสูงกว่ามาก่อน ถ้าเท่ากันเลือกข้อมูลที่ใหม่กว่า
      return (
        b.analysis.score - a.analysis.score ||
        b.scannedAt - a.scannedAt
      );
    });

  if (!candidates.length) {
    return {
      symbol: null,
      signal: "WAIT",
      score: 0,
      message: "ยังไม่มีคู่เงินที่ผ่านเกณฑ์",
      selectedAt: now
    };
  }

  const best = candidates[0];

  return {
    symbol: best.symbol,
    signal: best.analysis.signal,
    score: best.analysis.score,
    close: best.analysis.close,
    rsi: best.analysis.rsi,
    candleTime: best.analysis.candleTime,
    scannedAt: best.scannedAt,
    message: "คู่เงินที่ได้คะแนนสูงสุดจากผลสแกน",
    selectedAt: now
  };
}

// ทำงานสแกนอัตโนมัติวนไปเรื่อย ๆ
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function startAutoScanner() {
  if (scannerRunning) return;

  scannerRunning = true;

  while (scannerRunning) {
    let fullCycleCompleted = true;

    for (const symbol of SYMBOLS) {
      if (!scannerRunning) break;

      scannerBusy = true;
      currentScanSymbol = symbol;

      await scanOneSymbol(symbol);
      lastScanTime = Date.now();

      if (scanResults.get(symbol)?.stale) {
        fullCycleCompleted = false;
      }

      scannerBusy = false;

      await sleep(SCAN_INTERVAL_MS);
    }

    if (fullCycleCompleted && scannerRunning) {
      lastFullScanTime = Date.now();
      scannerError = null;
    }
  }
}

// API เดิม: วิเคราะห์คู่เงินที่ระบุ
app.get("/api/market", auth, async (req, res) => {
  const symbol = String(req.query.symbol || "EUR/USD").toUpperCase();

  if (!SYMBOLS.includes(symbol)) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported symbol"
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

// API ใหม่: ผลสแกนทั้งหมดและคู่เงินที่ระบบเลือก
app.get("/api/scan", auth, (_req, res) => {
  const results = SYMBOLS.map((symbol) => {
    return scanResults.get(symbol) || {
      symbol,
      analysis: {
        signal: "WAIT",
        score: 0,
        reasons: ["กำลังรอสแกน"]
      },
      scannedAt: null,
      candleTime: null,
      stale: true,
      error: null
    };
  });

  res.json({
    ok: true,
    mode: "auto-scan",
    timeframe: "1min",
    provider: "Twelve Data",
    scannerRunning,
    scannerBusy,
    currentScanSymbol,
    lastScanTime,
    lastFullScanTime,
    scannerError,
    totalSymbols: SYMBOLS.length,
    scannedSymbols: results.filter(
      (item) => item.scannedAt !== null && !item.stale
    ).length,
    selected: getBestSignal(),
    results
  });
});

// API ใหม่: ขอให้สแกนคู่ที่ข้อมูลเก่าที่สุดทันที
app.post("/api/scan/refresh", auth, async (_req, res) => {
  if (scannerBusy) {
    return res.status(409).json({
      ok: false,
      error: "Scanner is busy. Please try again shortly."
    });
  }

  const symbol = [...SYMBOLS].sort((a, b) => {
    const aTime = scanResults.get(a)?.scannedAt || 0;
    const bTime = scanResults.get(b)?.scannedAt || 0;
    return aTime - bTime;
  })[0];

  try {
    scannerBusy = true;
    currentScanSymbol = symbol;

    const result = await scanOneSymbol(symbol);
    lastScanTime = Date.now();

    res.json({
      ok: !result.stale,
      refreshed: symbol,
      result,
      selected: getBestSignal()
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message || "Scan failed"
    });
  } finally {
    scannerBusy = false;
    currentScanSymbol = null;
  }
});

// ตั้งปุ่ม Mini App ใน Telegram
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
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/telegram/link", (_req, res) => {
  if (!BOT_USERNAME) {
    return res.status(400).json({
      ok: false,
      error: "Bot username missing"
    });
  }

  res.json({
    ok: true,
    url: `https://t.me/${BOT_USERNAME}?startapp=radar`
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(root, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Market AI Radar listening on port ${PORT}`);

  startAutoScanner().catch((error) => {
    scannerError = error.message;
    scannerRunning = false;
    scannerBusy = false;
    console.error("Auto scanner stopped:", error);
  });
});
