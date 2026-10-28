
"use strict";

/* AI SIGNAL RADAR — public/app.js
   Forex Non-OTC / 1-minute
   Manual signals only. No broker orders.
*/

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
  audioContext: null,
  lastSignalIds: new Map(),
  initializedSignals: false
};

const API = {
  config: "/api/config",
  health: "/api/health",
  radar: "/api/radar",
  scan: "/api/scan",
  diagnostics: "/api/diagnostics"
};

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "—";
}

function setStatus(message, ok = null) {
  setText("connection", message);

  const dot = $("dot");
  if (dot) {
    dot.classList.toggle("online", ok === true);
    dot.classList.toggle("offline", ok === false);
  }
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n >= 20 ? n.toFixed(3) : n.toFixed(5);
}

function formatTime(value) {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function directionLabel(direction) {
  if (direction === "CALL") return "CALL ↑";
  if (direction === "PUT") return "PUT ↓";
  return "STANDBY";
}

function getSelectedPair() {
  return $("pairSelect")?.value || state.selectedPair;
}

async function fetchJSON(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    const body = await response.text();
    let data;

    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`API ไม่ได้ส่ง JSON กลับมา (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    }

    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("หมดเวลารอ API กรุณาลองอีกครั้ง");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

/* ---------------- SOUND ---------------- */

async function enableSoundFromTap() {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error("เบราว์เซอร์นี้ไม่รองรับ Web Audio");
  }

  if (!state.audioContext || state.audioContext.state === "closed") {
    state.audioContext = new AudioContextClass();
  }

  if (state.audioContext.state !== "running") {
    await state.audioContext.resume();
  }

  if (state.audioContext.state !== "running") {
    throw new Error("เปิดเสียงไม่สำเร็จ กรุณาตรวจการตั้งค่าเสียง");
  }

  state.soundEnabled = true;
  return true;
}

function playTone(frequency = 880, duration = 180, volume = 0.16) {
  const ctx = state.audioContext;

  if (!state.soundEnabled || !ctx || ctx.state !== "running") {
    return false;
  }

  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      volume,
      ctx.currentTime + 0.025
    );
    gain.gain.setValueAtTime(
      volume,
      ctx.currentTime + Math.max(0.03, duration / 1000 - 0.04)
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + duration / 1000
    );

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000 + 0.02);
    return true;
  } catch (error) {
    console.error("เล่นเสียงไม่สำเร็จ:", error);
    return false;
  }
}

function playAlert() {
  if (!state.soundEnabled) return;

  playTone(880, 180);
  window.setTimeout(() => playTone(1175, 220), 240);
}

/* ---------------- VIBRATION ---------------- */

function vibrateDevice(pattern = [180, 100, 250]) {
  if (!state.vibrationEnabled) return false;

  try {
    if (typeof navigator.vibrate !== "function") {
      setStatus("เบราว์เซอร์นี้ไม่รองรับการสั่น", false);
      return false;
    }

    const success = navigator.vibrate(pattern);

    if (!success) {
      setStatus("อุปกรณ์ไม่ยอมรับคำสั่งสั่น", false);
      return false;
    }

    return true;
  } catch (error) {
    console.warn("สั่นไม่สำเร็จ:", error);
    setStatus("ไม่สามารถสั่งสั่นจากเบราว์เซอร์นี้ได้", false);
    return false;
  }
}

/* ---------------- SIGNAL NOTIFICATIONS ---------------- */

function signalKey(result) {
  return [
    result.pair || "",
    result.direction || "STANDBY",
    result.stage || "",
    result.signalId || "",
    result.candleTime || ""
  ].join("|");
}

function notifyNewSignal(result) {
  if (!result || !result.pair) return;
  if (result.direction !== "CALL" && result.direction !== "PUT") return;

  const key = signalKey(result);
  const previous = state.lastSignalIds.get(result.pair);

  if (previous === key) return;

  state.lastSignalIds.set(result.pair, key);

  // จำผลแรกที่โหลดเข้ามาไว้ก่อน ป้องกันแจ้งเตือนย้อนหลังตอนเปิดแอป
  if (!state.initializedSignals) return;
  if (!state.notifications) return;
  if (document.visibilityState !== "visible") return;

  playAlert();
  vibrateDevice();
}

/* ---------------- CONFIG & HEALTH ---------------- */

async function loadConfig() {
  const data = await fetchJSON(API.config);
  state.config = data;

  const select = $("pairSelect");

  if (select && Array.isArray(data.pairs) && data.pairs.length) {
    const previous = state.selectedPair;
    select.replaceChildren();

    for (const pair of data.pairs) {
      const option = document.createElement("option");
      option.value = pair;
      option.textContent = pair;
      select.appendChild(option);
    }

    select.value = data.pairs.includes(previous) ? previous : data.pairs[0];
    state.selectedPair = select.value;
  }

  return data;
}

async function loadHealth() {
  try {
    const data = await fetchJSON(API.health);
    setStatus(data.ok ? "เชื่อมต่อแล้ว" : "เซิร์ฟเวอร์มีปัญหา", !!data.ok);

    setText(
      "errorText",
      data.lastError || "ไม่พบข้อผิดพลาดล่าสุด"
    );

    return data;
  } catch (error) {
    setStatus("เชื่อมต่อไม่ได้", false);
    setText("errorText", error.message);
    return null;
  }
}

/* ---------------- SIGNAL DISPLAY ---------------- */

function renderSignal(result) {
  if (!result) return;

  const direction = result.direction || "STANDBY";
  const stage = result.stage || "STANDBY";

  setText("signalTitle", directionLabel(direction));
  setText("stage", stage);
  setText("message", result.message || "รอจังหวะที่เหมาะสม");
  setText("pairLabel", result.pair || getSelectedPair());
  setText("price", formatPrice(result.price));
  setText("score", `${result.score ?? 0}/100`);

  const age = result.candleAgeSeconds ?? result.dataAgeSeconds;
  setText("age", age == null ? "ข้อมูลอายุ —" : `ข้อมูลอายุ ${age} วินาที`);

  setText("candleTime", result.candleTime || "—");
  setText("rsi", result.indicators?.rsi14 ?? "—");
  setText("ema6", result.indicators?.ema6 ?? "—");
  setText("ema21", result.indicators?.ema21 ?? "—");
  setText("ema50", result.indicators?.ema50 ?? "—");
  setText("macd", result.indicators?.macd ?? "—");

  const hero = $("hero");
  if (hero) {
    hero.classList.remove("call", "put", "standby");
    hero.classList.add(
      direction === "CALL" ? "call" :
      direction === "PUT" ? "put" : "standby"
    );
  }

  const bar = $("signalBar");
  if (bar) {
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    bar.style.width = `${score}%`;
  }

  const reasons = $("reasons");
  if (reasons) {
    reasons.replaceChildren();

    const items = Array.isArray(result.reasons) && result.reasons.length
      ? result.reasons
      : ["ระบบยังไม่มีเหตุผลสัญญาณเพิ่มเติม"];

    for (const reason of items) {
      const li = document.createElement("li");
      li.textContent = String(reason);
      reasons.appendChild(li);
    }
  }

  const early = result.early || {};
  const confirmed = result.confirmed || {};

  setText("earlyDir", directionLabel(early.direction));
  setText("earlyScore", `คะแนน ${early.score ?? "—"}`);

  setText("confirmedDir", directionLabel(confirmed.direction));
  setText("confirmedScore", `คะแนน ${confirmed.score ?? "—"}`);

  setText("updated", `อัปเดตหน้าจอ ${formatTime(new Date())}`);
}

/* ---------------- RADAR ---------------- */

function renderRadar(results) {
  const container = $("radar");
  if (!container || !Array.isArray(results)) return;

  container.replaceChildren();

  for (const result of results) {
    if (!result) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "radar-item";
    button.setAttribute("aria-label", `เลือกคู่เงิน ${result.pair}`);

    const pair = document.createElement("strong");
    pair.textContent = result.pair || "Unknown";

    const signal = document.createElement("span");
    signal.textContent = directionLabel(result.direction);

    const meta = document.createElement("small");
    meta.textContent =
      `${result.stage || "STANDBY"} · คะแนน ${result.score ?? 0}/100`;

    button.append(pair, signal, meta);

    button.classList.add(
      result.direction === "CALL" ? "call" :
      result.direction === "PUT" ? "put" : "standby"
    );

    button.addEventListener("click", () => {
      const select = $("pairSelect");
      if (select && [...select.options].some(o => o.value === result.pair)) {
        select.value = result.pair;
      }

      state.selectedPair = result.pair;
      renderSignal(result);
      scanSelectedPair();
    });

    container.appendChild(button);
  }
}

async function loadRadar() {
  const data = await fetchJSON(API.radar);

  const results = Array.isArray(data.results) ? data.results : [];

  for (const result of results) {
    if (result?.pair && !state.lastSignalIds.has(result.pair)) {
      state.lastSignalIds.set(result.pair, signalKey(result));
    } else {
      notifyNewSignal(result);
    }
  }

  renderRadar(results);

  const selected = results.find(r => r?.pair === getSelectedPair());
  if (selected) renderSignal(selected);

  setText(
    "updated",
    `ข้อมูลเซิร์ฟเวอร์ ${formatTime(data.lastPollAt)} · หน้าจอ ${formatTime(new Date())}`
  );

  setText(
    "errorText",
    data.lastError || "ไม่พบข้อผิดพลาดล่าสุด"
  );

  state.initializedSignals = true;
  return data;
}

/* ---------------- MANUAL SCAN ---------------- */

async function scanSelectedPair() {
  if (state.busy) return;

  const pair = getSelectedPair();
  if (!pair) {
    setStatus("กรุณาเลือกคู่เงิน", false);
    return;
  }

  state.selectedPair = pair;
  state.busy = true;

  const button = $("scanBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "กำลังสแกน...";
  }

  setStatus(`กำลังสแกน ${pair}...`);

  try {
    const url = `${API.scan}?pair=${encodeURIComponent(pair)}`;
    const data = await fetchJSON(url, 25000);

    if (data.result) {
      renderSignal(data.result);
      notifyNewSignal(data.result);
    } else {
      setStatus("API ตอบกลับแล้ว แต่ไม่มี result", false);
    }

    if (Array.isArray(data.results)) {
      renderRadar(data.results);
    }

    setStatus(`สแกน ${data.scannedPair || pair} แล้ว`, true);
    setText("updated", `สแกนล่าสุด ${formatTime(new Date())}`);

    // ดึงเรดาร์ล่าสุดโดยไม่สั่งสแกนซ้ำ
    try {
      await loadRadar();
      setStatus(`เชื่อมต่อแล้ว · ${pair}`, true);
    } catch (error) {
      console.warn("โหลดเรดาร์ไม่สำเร็จ:", error);
    }
  } catch (error) {
    setStatus(`สแกนไม่สำเร็จ: ${error.message}`, false);
    setText("errorText", error.message);
  } finally {
    state.busy = false;
    if (button) {
      button.disabled = false;
      button.textContent = "สแกนตอนนี้";
    }
  }
}

/* ---------------- DIAGNOSTICS ---------------- */

async function showDiagnostics() {
  const button = $("diagnosticsBtn");
  const output = $("diagnostics");

  if (button) {
    button.disabled = true;
    button.textContent = "กำลังตรวจ...";
  }

  try {
    const data = await fetchJSON(API.diagnostics);
    if (output) {
      output.textContent = JSON.stringify(data, null, 2);
      output.classList.remove("hidden");
    }
    setStatus("ตรวจสอบระบบสำเร็จ", true);
  } catch (error) {
    if (output) {
      output.textContent = error.message;
      output.classList.remove("hidden");
    }
    setStatus("ตรวจสอบระบบไม่สำเร็จ", false);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "ตรวจสอบระบบ";
    }
  }
}

/* ---------------- BUTTONS & TOGGLES ---------------- */

function bindControls() {
  $("scanBtn")?.addEventListener("click", scanSelectedPair);

  $("soundBtn")?.addEventListener("click", async () => {
    const button = $("soundBtn");

    if (state.soundEnabled) {
      state.soundEnabled = false;
      if (button) button.textContent = "เปิดเสียง";
      setStatus("ปิดเสียงแล้ว");
      return;
    }

    try {
      // เรียกจากการแตะปุ่มโดยตรงเพื่อให้เบราว์เซอร์อนุญาตเสียง
      await enableSoundFromTap();
      if (button) button.textContent = "ปิดเสียง";
      playTone(880, 180);
      setStatus("เปิดเสียงแล้ว · ได้ยินเสียงทดสอบหรือไม่?");
    } catch (error) {
      setStatus(error.message, false);
    }
  });

  $("vibrateBtn")?.addEventListener("click", () => {
    if (typeof navigator.vibrate !== "function") {
      setStatus(
        "เบราว์เซอร์นี้ไม่รองรับการสั่น กรุณาทดลอง Chrome บน Android",
        false
      );
      return;
    }

    // การกดปุ่มนี้เป็นการเปิดใช้งานและทดสอบสั่นในครั้งเดียว
    state.vibrationEnabled = true;

    const success = navigator.vibrate([250, 120, 250]);

    if (success) {
      $("vibrateBtn").textContent = "ทดสอบสั่นอีกครั้ง";
      setStatus("ส่งคำสั่งสั่นแล้ว หากไม่สั่นอาจเป็นข้อจำกัดของอุปกรณ์");
    } else {
      setStatus("อุปกรณ์หรือเบราว์เซอร์ปฏิเสธคำสั่งสั่น", false);
    }
  });

  $("pairSelect")?.addEventListener("change", async () => {
    state.selectedPair = getSelectedPair();
    setStatus(`เลือก ${state.selectedPair} แล้ว`);
    await scanSelectedPair();
  });

  $("autoToggle")?.addEventListener("change", () => {
    state.autoRefresh = $("autoToggle").checked;
    startAutoRefresh();
    setStatus(
      state.autoRefresh ? "เปิดรีเฟรชอัตโนมัติแล้ว" : "ปิดรีเฟรชอัตโนมัติแล้ว"
    );
  });

  $("notifyToggle")?.addEventListener("change", () => {
    state.notifications = $("notifyToggle").checked;
    setStatus(
      state.notifications
        ? "เปิดการแจ้งเตือนสัญญาณแล้ว"
        : "ปิดการแจ้งเตือนสัญญาณแล้ว"
    );
  });

  $("refreshRadar")?.addEventListener("click", async () => {
    try {
      await loadRadar();
      setStatus("รีเฟรชเรดาร์แล้ว", true);
    } catch (error) {
      setStatus(`รีเฟรชไม่สำเร็จ: ${error.message}`, false);
    }
  });

  $("diagnosticsBtn")?.addEventListener("click", showDiagnostics);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadRadar().catch(error => console.warn(error));
      loadHealth();
    }
  });
}

/* ---------------- AUTO REFRESH ---------------- */

function startAutoRefresh() {
  if (state.timer) {
    window.clearInterval(state.timer);
    state.timer = null;
  }

  if (!state.autoRefresh) return;

  // รีเฟรชหน้าเว็บ ไม่ได้เรียก Twelve Data ใหม่ทุกครั้ง
  const configured = Number(state.config?.pollIntervalMs || 15000);
  const interval = Math.max(5000, Math.min(configured, 30000));

  state.timer = window.setInterval(async () => {
    if (document.visibilityState !== "visible") return;

    try {
      await loadRadar();
    } catch (error) {
      console.warn("Auto refresh failed:", error);
      setStatus("กำลังรอการเชื่อมต่อใหม่", false);
    }
  }, interval);
}

/* ---------------- START ---------------- */

async function init() {
  bindControls();
  setStatus("กำลังเชื่อมต่อ...");

  try {
    await loadConfig();
    await loadHealth();
    await loadRadar();

    startAutoRefresh();

    // สแกนคู่เงินที่เลือกทันทีหลังเปิดหน้า
    scanSelectedPair().catch(error => console.error(error));
  } catch (error) {
    console.error("Startup error:", error);
    setStatus(`เริ่มระบบไม่สำเร็จ: ${error.message}`, false);
    setText("errorText", error.message);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
