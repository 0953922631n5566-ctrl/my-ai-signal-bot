
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(root, "public")));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.TWELVEDATA_API_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
const APP_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const ALLOWLIST = (process.env.ALLOWED_TELEGRAM_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const SYMBOLS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
  "USD/CHF", "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY"
];

const cache = new Map();
const CACHE_MS = 12000;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    dataKeyConfigured: Boolean(API_KEY),
    telegramConfigured: Boolean(BOT_TOKEN && APP_URL),
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    symbols: SYMBOLS,
    timeframe: "1min",
    mode: "signal-only",
    dataProvider: "Twelve Data"
  });
});

function verifyTelegram(initData) {
  if (!BOT_TOKEN) return { ok: false, error: "Bot token not configured" };
  if (!initData) return { ok: false, error: "Open through Telegram Mini App" };

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, error: "Missing Telegram signature" };

    params.delete("hash");

    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secret = crypto.createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN).digest();

    const expected = crypto.createHmac("sha256", secret)
      .update(checkString).digest("hex");

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
    return { ok: false, error: "Telegram authentication failed" };
  }
}

function auth(req, res, next) {
  const result = verifyTelegram(req.get("x-telegram-init-data") || "");
  if (!result.ok) return res.status(401).json(result);
  req.telegramUser = result.user;
  next();
}

async function getCandles(symbol) {
  if (!API_KEY) throw new Error("Missing TWELVEDATA_API_KEY");

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

  if (!response.ok) {
    throw new Error(`Market provider HTTP ${response.status}`);
  }

  const json = await response.json();

  if (!Array.isArray(json.values)) {
    throw new Error(json.message || "No market candles returned");
  }

  const candles = json.values.map(c => ({
    time: Date.parse(c.datetime.replace(" ", "T") + "Z"),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume || 0)
  }))
  .filter(c => Number.isFinite(c.time) &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite))
  .sort((a, b) => a.time - b.time);

  if (candles.length < 60) {
    throw new Error("Waiting for sufficient market history");
  }

  cache.set(symbol, { at: Date.now(), candles });
  return candles;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let value = values.slice(0, period)
    .reduce((sum, n) => sum + n, 0) / period;

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

  let gains = 0, losses = 0;

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
  // Only analyze candles that should have finished.
  const now = Date.now();
  const candles = allCandles.filter(c => c.time + 60000 <= now);

  if (candles.length < 50) {
    throw new Error("Not enough closed candles");
  }

  const closes = candles.map(c => c.close);
  const last = closes.length - 1;
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes.slice(-60), 14);
  const current = candles[last];
  const previous = candles[last - 1];

  const trendUp = e9[last] > e21[last] && e21[last] > e50[last];
  const trendDown = e9[last] < e21[last] && e21[last] < e50[last];

  const range = Math.max(current.high - current.low, 1e-10);
  const body = (current.close - current.open) / range;

  let call = 0;
  let put = 0;
  const reasons = [];

  if (trendUp) {
    call += 2;
    reasons.push("EMA bullish alignment");
  }
  if (trendDown) {
    put += 2;
    reasons.push("EMA bearish alignment");
  }

  if (r >= 52 && r <= 68) {
    call++;
    reasons.push("RSI bullish momentum");
  }
  if (r <= 48 && r >= 32) {
    put++;
    reasons.push("RSI bearish momentum");
  }

  if (current.close > previous.close) call++;
  if (current.close < previous.close) put++;
  if (body > 0.35) call++;
  if (body < -0.35) put++;

  let signal = "WAIT";

  if (trendUp && call >= 3 && call - put >= 2 && r < 70) {
    signal = "CALL";
  }

  if (trendDown && put >= 3 && put - call >= 2 && r > 30) {
    signal = "PUT";
  }

  return {
    signal,
    callScore: call,
    putScore: put,
    rsi: Number(r.toFixed(1)),
    close: current.close,
    candleTime: current.time,
    ema9: e9[last],
    ema21: e21[last],
    ema50: e50[last],
    reasons,
    sampleSize: candles.length,
    note: "Technical signal only; not a calibrated win probability"
  };
}

app.get("/api/market", auth, async (req, res) => {
  const symbol = String(req.query.symbol || "EUR/USD").toUpperCase();

  if (!SYMBOLS.includes(symbol)) {
    return res.status(400).json({ ok: false, error: "Unsupported symbol" });
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

// Configure the bot's menu button without posting messages to any chat.
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

app.listen(PORT, () => {
  console.log(`Market AI Radar listening on port ${PORT}`);
});
