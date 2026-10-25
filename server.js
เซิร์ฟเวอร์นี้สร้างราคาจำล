
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: "32kb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const MINI_APP_URL = process.env.MINI_APP_URL || PUBLIC_URL;

// DEMO ONLY: these are synthetic starting prices.
const instruments = [
  { key: "EURUSD-OTC", name: "EUR/USD OTC", price: 1.08420, digits: 5, vol: 0.000035 },
  { key: "GBPUSD-OTC", name: "GBP/USD OTC", price: 1.27180, digits: 5, vol: 0.000045 },
  { key: "USDJPY-OTC", name: "USD/JPY OTC", price: 149.320, digits: 3, vol: 0.018 },
  { key: "AUDUSD-OTC", name: "AUD/USD OTC", price: 0.65920, digits: 5, vol: 0.000038 },
  { key: "USDCAD-OTC", name: "USD/CAD OTC", price: 1.37120, digits: 5, vol: 0.000040 },
  { key: "EURGBP-OTC", name: "EUR/GBP OTC", price: 0.85320, digits: 5, vol: 0.000028 }
];

const market = new Map();

for (const item of instruments) {
  const history = Array.from({ length: 60 }, (_, i) => ({
    time: Date.now() - (59 - i) * 1000,
    price: item.price
  }));

  market.set(item.key, {
    ...item,
    history,
    phase: Math.random() * Math.PI * 2,
    lastTickAt: Date.now()
  });
}

function nextPrice(s) {
  // Random walk for UI and algorithm testing, not market forecasting.
  const noise =
    Math.random() + Math.random() +
    Math.random() + Math.random() - 2;

  s.phase += (Math.random() - 0.5) * 0.20;

  const drift = Math.sin(s.phase) * s.vol * 0.12;
  const delta = noise * s.vol * 1.15 + drift;

  return Number(Math.max(0.00001, s.price + delta).toFixed(s.digits));
}

function updateMarket() {
  const now = Date.now();

  for (const s of market.values()) {
    s.price = nextPrice(s);
    s.lastTickAt = now;
    s.history.push({ time: now, price: s.price });

    if (s.history.length > 180) {
      s.history.shift();
    }
  }
}

function snapshot() {
  return {
    type: "scanner_update",
    mode: "SIMULATED",
    source: "SYNTHETIC_DEMO",
    generatedAt: Date.now(),
    pairs: [...market.values()].map(s => ({
      key: s.key,
      name: s.name,
      price: s.price,
      digits: s.digits,
      lastTickAt: s.lastTickAt,
      history: s.history
    }))
  };
}

function broadcast() {
  const message = JSON.stringify(snapshot());

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

setInterval(updateMarket, 1000);
setInterval(broadcast, 1000);
updateMarket();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "SIMULATED",
    source: "SYNTHETIC_DEMO",
    connected: true,
    pairs: instruments.length,
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_req, res) => {
  res.json(snapshot());
});

app.get("/api/config", (_req, res) => {
  res.json({
    mode: "SIMULATED",
    signalHoldSeconds: 40,
    warningSeconds: 10,
    finalAlertSeconds: 2,
    pairs: instruments.map(({ key, name, digits }) => ({
      key, name, digits
    }))
  });
});

async function telegram(method, payload) {
  if (!BOT_TOKEN) throw new Error("Missing bot token");

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.description || "Telegram API error");
  }

  return result.result;
}

// Telegram sends /start here.
// Signals are never posted to the chat; only a launch button is sent.
app.post("/telegram/webhook", async (req, res) => {
  if (WEBHOOK_SECRET) {
    const supplied =
      req.get("x-telegram-bot-api-secret-token") || "";

    const a = Buffer.from(supplied);
    const b = Buffer.from(WEBHOOK_SECRET);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.sendStatus(401);
    }
  }

  res.sendStatus(200);

  const message = req.body?.message;
  const chatId = message?.chat?.id;
  const text = (message?.text || "").trim();

  if (!chatId || !/^\/start(?:@\w+)?(?:\s|$)/.test(text)) return;

  try {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "เปิด OTC Radar Mini App เพื่อดูเรดาร์และสัญญาณจำลอง",
      reply_markup: {
        inline_keyboard: [[{
          text: "🚀 เปิด OTC Radar",
          web_app: { url: MINI_APP_URL }
        }]]
      }
    });
  } catch (error) {
    console.error("Telegram error:", error.message);
  }
});

// Call once after deploying to configure the Telegram webhook/menu.
// Protect this endpoint with your own admin authentication before
// exposing it in a production deployment.
app.get("/api/telegram/setup", async (_req, res) => {
  if (!BOT_TOKEN || !PUBLIC_URL || !MINI_APP_URL) {
    return res.status(400).json({
      ok: false,
      error: "Configure BOT_TOKEN, PUBLIC_URL and MINI_APP_URL."
    });
  }

  try {
    await telegram("setWebhook", {
      url: `${PUBLIC_URL}/telegram/webhook`,
      secret_token: WEBHOOK_SECRET || undefined,
      allowed_updates: ["message"]
    });

    await telegram("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Open Radar",
        web_app: { url: MINI_APP_URL }
      }
    });

    res.json({ ok: true, message: "Telegram Mini App configured" });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`OTC Radar running on ${PORT} (SIMULATED MODE)`);
});
