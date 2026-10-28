
"use strict";

/* =========================================
   AI SIGNAL RADAR — public/app.js
   Forex Non-OTC / 1-minute signals
   Manual trading only; no broker orders.
========================================= */

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  selectedPair: "EUR/USD",
  autoRefresh: true,
  notifications: true,
  soundEnabled: false,
  vibrationEnabled: false,
  busy: false,
  timer: null,
  lastSignalIds: new Map(),
  audioContext: null
};

function firstElement(...ids) {
  for (const id of ids) {
    const el = $(id);
    if (el) return el;
  }
  return null;
}

function setText(ids, value) {
  const el = Array.isArray(ids)
    ? firstElement(...ids)
    : $(ids);

  if (el) el.textContent = value ?? "—";
}

function setStatus(message) {
  setText(
    ["connectionStatus", "connection-status", "statusText", "appStatus"],
    message
  );
}

function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }

  const n = Number(value);
  return n >= 20 ? n.toFixed(3) : n.toFixed(5);
}

function formatTime(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function directionLabel(direction) {
  if (direction === "CALL") return "CALL ↑";
  if (direction === "PUT") return "PUT ↓";
  return "STANDBY";
}

function getSelectedPair() {
  const select = firstElement(
    "pairSelect",
    "pair",
    "pairSelector",
    "currencyPair"
  );

  return select?.value || state.selectedPair;
}

function isStale(result) {
  return !result || result.stale === true ||
    result.direction === "STANDBY";
}

/* ---------- Sound and vibration ---------- */

function unlockAudio() {
  try {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) return false;

    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
    }

    if (state.audioContext.state === "suspended") {
      state.audioContext.resume().catch(() => {});
    }

    state.soundEnabled = true;
    return true;
  } catch (error) {
    console.warn("Audio is unavailable:", error);
    return false;
  }
}

function playTone(frequency = 880, duration = 180, volume = 0.12) {
  if (!state.soundEnabled || !state.audioContext) return;

  try {
    const ctx = state.audioContext;
    if (ctx.state !== "running") return;

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + duration / 1000
    );

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000);
  } catch (error) {
    console.warn("Unable to play tone:", error);
  }
}

function playAlert() {
  playTone(880, 180);
  window.setTimeout(() => playTone(1175, 220), 220);
}

function vibrateAlert() {
  if (!state.vibrationEnabled) return;

  try {
    if ("vibrate" in navigator) {
      navigator.vibrate([180, 100, 250]);
    }
  } catch (error) {
    console.warn("Vibration unavailable:", error);
  }
}

function notifyNewSignal(result) {
  if (!state.notifications || !result?.signalId) return;
  if (result.direction === "STANDBY") return;

  const key = result.pair;
  const previousId = state.lastSignalIds.get(key);

  if (previousId === result.signalId) return;

  state.lastSignalIds.set(key, result.signalId);

  // Do not play an alert for the first result loaded after opening the app.
  if (previousId === undefined) return;

  if (document.visibilityState === "visible") {
    playAlert();
    vibrateAlert();
  }
}

/* ---------- API ---------- */

async function fetchJSON(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`เซิร์ฟเวอร์ส่งข้อมูลที่ไม่ใช่ JSON (${response.status})`);
    }

    if (!response.ok) {
      throw new Error(
        data.error || data.message || `HTTP ${response.status}`
      );
    }

    return data;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadConfig() {
  const config = await fetchJSON("/api/config");
  state.config = config;

  if (Array.isArray(config.pairs) && config.pairs.length) {
    const select = firstElement(
      "pairSelect",
      "pair",
      "pairSelector",
      "currencyPair"
    );

    if (select) {
      const current = select.value;
      select.replaceChildren();

      for (const pair of config.pairs) {
        const option = document.createElement("option");
        option.value = pair;
        option.textContent = pair;
        select.appendChild(option);
      }

      select.value = config.pairs.includes(current)
        ? current
        : config.pairs[0];
    }

    state.selectedPair = getSelectedPair();
  }

  state.autoRefresh = true;
  renderConfig(config);
  return config;
}

function renderConfig(config) {
  setText(
    ["timeframe", "timeframeText"],
    config.timeframe || "1 นาที"
  );

  setText(
    ["sourceText", "dataSource"],
    config.source || "Twelve Data REST"
  );
}

async function loadHealth() {
  try {
    const data = await fetchJSON("/api/health");

    setStatus(data.ok ? "เชื่อมต่อแล้ว" : "เซิร์ฟเวอร์มีปัญหา");

    setText(
      ["apiStatus", "serverStatus"],
      data.lastError || "ไม่พบข้อผิดพลาดล่าสุด"
    );

    return data;
  } catch (error) {
    setStatus("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
    setText(["apiStatus", "serverStatus"], error.message);
    return null;
  }
}

async function loadRadar() {
  const data = await fetchJSON("/api/radar");

  if (Array.isArray(data.results)) {
    for (const result of data.results) {
      if (result) notifyNewSignal(result);
    }

    renderRadar(data.results);

    const selected = data.results.find(
      result => result.pair === getSelectedPair()
    );

    if (selected) renderSignal(selected);
  }

  setText(
    ["lastUpdated", "updatedAt", "updateTime"],
    `อัปเดต ${formatTime(data.lastPollAt)}`
  );

  setText(
    ["apiStatus", "serverStatus"],
    data.lastError || "ไม่พบข้อผิดพลาดล่าสุด"
  );

  return data;
}

/*
 * Scan the pair currently selected in the UI.
 * The server must contain the updated /api/scan?pair=... route.
 */
async function scanSelectedPair() {
  if (state.busy) return;

  const pair = getSelectedPair();
  if (!pair) {
    setStatus("กรุณาเลือกคู่เงิน");
    return;
  }

  state.selectedPair = pair;
  state.busy = true;

  const scanButton = firstElement(
    "scanButton",
    "scanNow",
    "scanBtn",
    "rescanButton"
  );

  if (scanButton) {
    scanButton.disabled = true;
    scanButton.dataset.originalText =
      scanButton.textContent || "สแกนตอนนี้";
    scanButton.textContent = "กำลังสแกน...";
  }

  setStatus(`กำลังสแกน ${pair}`);

  try {
    const url = `/api/scan?pair=${encodeURIComponent(pair)}`;
    const data = await fetchJSON(url, 20000);

    if (data.result) {
      notifyNewSignal(data.result);
      renderSignal(data.result);
    }

    if (Array.isArray(data.results)) {
      renderRadar(data.results);
    }

    setText(
      ["lastUpdated", "updatedAt", "updateTime"],
      `อัปเดต ${formatTime(data.lastPollAt)}`
    );

    setStatus(`สแกน ${data.scannedPair || pair} แล้ว`);

    // Refresh the full radar separately without starting another scan.
    await loadRadar().catch(error => {
      console.warn("Radar refresh failed:", error);
    });
  } catch (error) {
    setStatus(`สแกนไม่สำเร็จ: ${error.message}`);
  } finally {
    state.busy = false;

    if (scanButton) {
      scanButton.disabled = false;
      scanButton.textContent =
        scanButton.dataset.originalText || "สแกนตอนนี้";
    }
  }
}

/* ---------- Signal rendering ---------- */

function renderSignal(result) {
  if (!result) return;

  const direction = result.direction || "STANDBY";
  const stage = result.stage || "STANDBY";

  setText(["signalDirection", "direction", "mainSignal"], directionLabel(direction));
  setText(["signalStage", "stage", "signalType"], stage);
  setText(["signalMessage", "message"], result.message || "—");
  setText(["selectedPair", "signalPair", "pairName"], result.pair || "—");
  setText(["latestPrice", "price", "signalPrice"], formatPrice(result.price));
  setText(["signalScore", "score"], `${result.score ?? 0}/100`);
  setText(["dataAge", "dataAgeSeconds"], `${result.candleAgeSeconds ?? result.dataAgeSeconds ?? "—"} วินาที`);
  setText(["candleTime", "candleTimestamp"], result.candleTime || "—");

  const directionClass =
    direction === "CALL" ? "call" :
    direction === "PUT" ? "put" : "standby";

  const signalCard = firstElement(
    "signalCard",
    "liveSignal",
    "signalPanel"
  );

  if (signalCard) {
    signalCard.classList.remove("call", "put", "standby");
    signalCard.classList.add(directionClass);
  }

  const indicators = result.indicators || {};

  setText(["rsiValue", "rsi"], indicators.rsi14 ?? "—");
  setText(["ema6Value", "ema6"], indicators.ema6 ?? "—");
  setText(["ema21Value", "ema21"], indicators.ema21 ?? "—");
  setText(["ema50Value", "ema50"], indicators.ema50 ?? "—");
  setText(["macdValue", "macd"], indicators.macd ?? "—");

  renderReasons(result.reasons || []);
  renderScanLevels(result);
}

function renderReasons(reasons) {
  const list = firstElement(
    "signalReasons",
    "reasonsList",
    "reasons"
  );

  if (!list) return;

  list.replaceChildren();

  for (const reason of reasons) {
    const li = document.createElement("li");
    li.textContent = reason;
    list.appendChild(li);
  }
}

function renderScanLevels(result) {
  const early = result.early || {};
  const confirmed = result.confirmed || {};

  setText(
    ["earlyDirection", "earlySignal"],
    directionLabel(early.direction)
  );
  setText(["earlyScore"], `${early.score ?? 0}`);

  setText(
    ["confirmedDirection", "confirmedSignal"],
    directionLabel(confirmed.direction)
  );
  setText(["confirmedScore"], `${confirmed.score ?? 0}`);
}

/* ---------- Radar rendering ---------- */

function renderRadar(results) {
  const container = firstElement(
    "radarList",
    "radarResults",
    "pairRadar",
    "radar"
  );

  if (!container) return;

  container.replaceChildren();

  for (const result of results) {
    if (!result) continue;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "radar-item";
    card.setAttribute("aria-label", `เลือก ${result.pair}`);

    const pair = document.createElement("strong");
    pair.textContent = result.pair;

    const signal = document.createElement("span");
    signal.textContent = directionLabel(result.direction);

    const meta = document.createElement("small");
    meta.textContent =
      `${result.stage || "STANDBY"} · ${result.score ?? 0}/100`;

    card.append(pair, signal, meta);

    if (result.direction === "CALL") card.classList.add("call");
    else if (result.direction === "PUT") card.classList.add("put");
    else card.classList.add("standby");

    card.addEventListener("click", () => {
      const select = firstElement(
        "pairSelect",
        "pair",
        "pairSelector",
        "currencyPair"
      );

      if (select) select.value = result.pair;
      state.selectedPair = result.pair;
      renderSignal(result);
    });

    container.appendChild(card);
  }
}

/* ---------- Controls ---------- */

function bindControls() {
  const scanButton = firstElement(
    "scanButton",
    "scanNow",
    "scanBtn",
    "rescanButton"
  );

  scanButton?.addEventListener("click", scanSelectedPair);

  const pairSelect = firstElement(
    "pairSelect",
    "pair",
    "pairSelector",
    "currencyPair"
  );

  pairSelect?.addEventListener("change", () => {
    state.selectedPair = getSelectedPair();

    loadRadar()
      .then(() => scanSelectedPair())
      .catch(error => setStatus(error.message));
  });

  const soundButton = firstElement(
    "soundButton",
    "soundToggle",
    "enableSound"
  );

  soundButton?.addEventListener("click", () => {
    const enabled = unlockAudio();

    if (enabled) {
      state.soundEnabled = true;
      playTone(880, 130);
      soundButton.textContent = "ปิดเสียง";
      setStatus("เปิดเสียงแล้ว");
    } else {
      setStatus("เบราว์เซอร์ไม่รองรับเสียง");
    }
  });

  const vibrationButton = firstElement(
    "vibrationButton",
    "vibrationToggle",
    "testVibration"
  );

  vibrationButton?.addEventListener("click", () => {
    if (!("vibrate" in navigator)) {
      setStatus("อุปกรณ์หรือเบราว์เซอร์นี้ไม่รองรับการสั่น");
      return;
    }

    state.vibrationEnabled = true;
    navigator.vibrate([150, 80, 150]);

    if (vibrationButton) {
      vibrationButton.textContent = "ทดสอบสั่นแล้ว";
    }

    setStatus("เปิดการสั่นแล้ว");
  });

  const notificationButton = firstElement(
    "notificationButton",
    "notificationsToggle",
    "notifyToggle"
  );

  notificationButton?.addEventListener("click", () => {
    state.notifications = !state.notifications;
    notificationButton.textContent = state.notifications
      ? "ปิดแจ้งเตือน"
      : "เปิดแจ้งเตือน";
  });

  const autoRefresh = firstElement(
    "autoRefresh",
    "autoRefreshToggle",
    "refreshToggle"
  );

  autoRefresh?.addEventListener("change", () => {
    state.autoRefresh = Boolean(autoRefresh.checked);
    startAutoRefresh();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadRadar().catch(() => {});
    }
  });
}

/* ---------- Automatic refresh ---------- */

function startAutoRefresh() {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }

  if (!state.autoRefresh) return;

  const configuredInterval = Number(
    state.config?.pollIntervalMs || 25000
  );

  // Refresh display from the server; this does not force an API request
  // to Twelve Data on every UI refresh.
  const refreshInterval = Math.max(5000, Math.min(configuredInterval, 30000));

  state.timer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;

    loadRadar().catch(error => {
      console.warn("Auto refresh failed:", error);
    });
  }, refreshInterval);
}

/* ---------- Startup ---------- */

async function init() {
  bindControls();
  setStatus("กำลังเชื่อมต่อ...");

  try {
    await loadConfig();
    await loadHealth();
    await loadRadar();

    startAutoRefresh();

    // First scan of the selected pair on startup.
    scanSelectedPair().catch(error => {
      console.warn("Initial scan failed:", error);
    });
  } catch (error) {
    setStatus(`เริ่มระบบไม่สำเร็จ: ${error.message}`);
    console.error(error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
