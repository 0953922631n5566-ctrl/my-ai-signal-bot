
const $ = id => document.getElementById(id);

const state = {
  pairs: [],
  selected: "",
  config: null,
  results: {},
  seenSignals: new Set(),
  audio: null,
  soundReady: false
};

const timer = {
  refresh: null
};

function setConnection(text, good) {
  $("connection").textContent = text;
  $("dot").style.background = good ? "var(--green)" : "#ff6378";
}

function directionLabel(direction) {
  if (direction === "CALL") return "CALL ↑";
  if (direction === "PUT") return "PUT ↓";
  return "STANDBY";
}

function formatNumber(value, digits = 5) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  return Number(value).toFixed(digits);
}

function safeText(id, value) {
  $(id).textContent =
    value === null || value === undefined ? "—" : String(value);
}

async function getJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

/* ---------- Sound and vibration ---------- */

async function unlockSound() {
  try {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error("Browser does not support Web Audio");
    }

    if (!state.audio) state.audio = new AudioContextClass();

    if (state.audio.state === "suspended") {
      await state.audio.resume();
    }

    state.soundReady = true;
    playTone(850, 0.15);
    $("soundBtn").textContent = "เสียงเปิดแล้ว";
  } catch (error) {
    $("message").textContent =
      "เปิดเสียงไม่สำเร็จ กรุณาอนุญาตเสียงในเบราว์เซอร์";
  }
}

function playTone(frequency, duration) {
  if (!state.audio || !state.soundReady) return;

  try {
    const oscillator = state.audio.createOscillator();
    const gain = state.audio.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.08;

    oscillator.connect(gain);
    gain.connect(state.audio.destination);

    oscillator.start();

    gain.gain.exponentialRampToValueAtTime(
      0.001,
      state.audio.currentTime + duration
    );

    oscillator.stop(state.audio.currentTime + duration);
  } catch (_) {}
}

function vibrate(pattern) {
  try {
    if ("vibrate" in navigator) navigator.vibrate(pattern);
  } catch (_) {}
}

function notifySignal(data) {
  if (!$("notifyToggle").checked) return;
  if (document.visibilityState !== "visible") return;

  if (data.direction === "CALL") {
    playTone(880, 0.17);
    setTimeout(() => playTone(1100, 0.18), 200);
    vibrate([180, 70, 180]);
  } else if (data.direction === "PUT") {
    playTone(520, 0.2);
    setTimeout(() => playTone(390, 0.2), 220);
    vibrate([280, 80, 280]);
  }
}

/* ---------- Render selected pair ---------- */

function renderResult(data) {
  if (!data || !data.pair) return;

  state.results[data.pair] = data;

  if (data.pair !== state.selected) {
    renderRadar();
    return;
  }

  const hero = $("hero");

  hero.classList.remove("call", "put", "standby");

  hero.classList.add(
    data.direction === "CALL"
      ? "call"
      : data.direction === "PUT"
        ? "put"
        : "standby"
  );

  safeText("signalTitle", directionLabel(data.direction));
  safeText("stage", data.stage || "STANDBY");
  safeText("message", data.message || "รอข้อมูล");
  safeText("pairLabel", data.pair);
  safeText("price", formatNumber(data.price, 5));

  safeText(
    "score",
    data.direction === "STANDBY" ? "—" : `${data.score}/100`
  );

  $("signalBar").style.width =
    `${Math.min(100, Math.max(0, Number(data.score) || 0))}%`;

  safeText(
    "updated",
    data.updatedAt
      ? `อัปเดต ${new Date(data.updatedAt).toLocaleTimeString()}`
      : "ยังไม่มีข้อมูลอัปเดต"
  );

  safeText(
    "age",
    data.dataAgeSeconds == null
      ? "ข้อมูล —"
      : `อายุข้อมูล ${data.dataAgeSeconds} วินาที`
  );

  safeText("earlyDir", directionLabel(data.early?.direction));
  safeText("earlyScore", `คะแนน ${data.early?.score ?? "—"}`);

  safeText(
    "confirmedDir",
    directionLabel(data.confirmed?.direction)
  );

  safeText(
    "confirmedScore",
    `คะแนน ${data.confirmed?.score ?? "—"}`
  );

  const indicators = data.indicators || {};

  safeText("rsi", formatNumber(indicators.rsi14, 2));
  safeText("ema6", formatNumber(indicators.ema6, 5));
  safeText("ema21", formatNumber(indicators.ema21, 5));
  safeText("ema50", formatNumber(indicators.ema50, 5));
  safeText("macd", formatNumber(indicators.macd, 6));
  safeText("candleTime", indicators.candleTime || data.candleTime || "—");

  const list = $("reasons");
  list.replaceChildren();

  const reasons = Array.isArray(data.reasons) && data.reasons.length
    ? data.reasons
    : ["ยังไม่มีเงื่อนไขที่ผ่านเกณฑ์"];

  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    list.appendChild(item);
  }

  // A signal is notified once per unique signal ID in this page session.
  if (
    data.direction !== "STANDBY" &&
    data.signalId &&
    !state.seenSignals.has(data.signalId)
  ) {
    state.seenSignals.add(data.signalId);

    if (state.seenSignals.size > 300) {
      const oldest = state.seenSignals.values().next().value;
      state.seenSignals.delete(oldest);
    }

    notifySignal(data);
  }

  renderRadar();
}

/* ---------- Radar list ---------- */

function renderRadar() {
  const root = $("radar");
  root.replaceChildren();

  for (const pair of state.pairs) {
    const data = state.results[pair] || {
      pair,
      direction: "STANDBY",
      stage: "WAITING",
      score: 0
    };

    const row = document.createElement("div");
    row.className =
      "radar-row" + (pair === state.selected ? " active" : "");

    const left = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = pair;

    const stage = document.createElement("div");
    stage.className = "small";
    stage.textContent = data.stage || "รอข้อมูล";

    left.append(name, stage);

    const right = document.createElement("div");
    right.className = "radar-right";

    const signal = document.createElement("div");
    signal.className = `radar-signal ${data.direction || "STANDBY"}`;
    signal.textContent = directionLabel(data.direction);

    const score = document.createElement("span");
    score.className = "small";
    score.textContent =
      data.direction === "STANDBY" ? "—" : `${data.score}/100`;

    right.append(signal, score);
    row.append(left, right);

    row.addEventListener("click", () => selectPair(pair));
    root.appendChild(row);
  }
}

function selectPair(pair) {
  if (!state.pairs.includes(pair)) return;

  state.selected = pair;
  $("pairSelect").value = pair;

  const result = state.results[pair];

  if (result) renderResult(result);
  else {
    safeText("pairLabel", pair);
    safeText("signalTitle", "STANDBY");
    safeText("message", "กำลังรอข้อมูลของคู่เงินนี้");
  }

  renderRadar();
}

/* ---------- API updates ---------- */

async function refreshRadar() {
  try {
    const data = await getJSON("/api/radar");

    if (Array.isArray(data.results)) {
      for (const result of data.results) {
        renderResult(result);
      }
    }

    safeText("errorText", data.lastError || "ไม่พบข้อผิดพลาดล่าสุด");
    setConnection("เชื่อมต่อแล้ว", true);
  } catch (error) {
    setConnection("เชื่อมต่อไม่ได้", false);
    safeText("errorText", error.message);
  }
}

async function scanNow() {
  const button = $("scanBtn");
  button.disabled = true;
  button.textContent = "กำลังสแกน…";

  try {
    await getJSON("/api/scan");
    await refreshRadar();
  } catch (error) {
    safeText("errorText", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "สแกนตอนนี้";
  }
}

function startRefresh() {
  stopRefresh();

  const interval = Math.max(
    10000,
    Number(state.config?.pollIntervalMs || 25000)
  );

  timer.refresh = setInterval(refreshRadar, interval);
}

function stopRefresh() {
  if (timer.refresh) clearInterval(timer.refresh);
  timer.refresh = null;
}

async function loadConfig() {
  try {
    state.config = await getJSON("/api/config");
    state.pairs = state.config.pairs || [];

    if (!state.pairs.length) {
      throw new Error("ไม่มีคู่เงินใน FOREX_PAIRS");
    }

    state.selected = state.pairs[0];

    const select = $("pairSelect");
    select.replaceChildren();

    for (const pair of state.pairs) {
      const option = document.createElement("option");
      option.value = pair;
      option.textContent = pair;
      select.appendChild(option);
    }

    select.value = state.selected;

    const health = await getJSON("/api/health");

    if (health.apiKeyConfigured) {
      setConnection("ตั้งค่า API แล้ว", true);
    } else {
      setConnection("ยังไม่ได้ตั้ง API Key", false);
      safeText(
        "errorText",
        "เพิ่ม TWELVE_DATA_API_KEY ใน Render Environment ก่อน"
      );
    }

    await refreshRadar();
    startRefresh();
  } catch (error) {
    setConnection("เริ่มระบบไม่สำเร็จ", false);
    safeText("errorText", error.message);
  }
}

/* ---------- Controls ---------- */

$("pairSelect").addEventListener("change", event => {
  selectPair(event.target.value);
});

$("scanBtn").addEventListener("click", scanNow);
$("refreshRadar").addEventListener("click", refreshRadar);
$("soundBtn").addEventListener("click", unlockSound);

$("vibrateBtn").addEventListener("click", () => {
  vibrate([200, 80, 200]);
});

$("autoToggle").addEventListener("change", event => {
  if (event.target.checked) startRefresh();
  else stopRefresh();
});

$("diagnosticsBtn").addEventListener("click", async () => {
  const panel = $("diagnostics");

  panel.classList.remove("hidden");
  panel.textContent = "กำลังตรวจสอบ…";

  try {
    const data = await getJSON("/api/diagnostics");
    panel.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    panel.textContent = error.message;
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshRadar();
});

if (window.Telegram && window.Telegram.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

loadConfig();
