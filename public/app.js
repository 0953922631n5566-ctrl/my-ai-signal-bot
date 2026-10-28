"use strict";

/* AI SIGNAL RADAR - compatible with the existing server.js API. Manual signals only; no broker orders are placed. */
const $ = (id) => document.getElementById(id);
const API = {
  config: "/api/config",
  health: "/api/health",
  radar: "/api/radar",
  scan: "/api/scan",
  diagnostics: "/api/diagnostics",
};

const state = {
  config: null,
  selectedPair: "EUR/USD",
  autoRefresh: true,
  notifications: true,
  soundEnabled: false,
  vibrationEnabled: false,
  busy: false,
  refreshTimer: null,
  countdownTimer: null,
  audioContext: null,
  lastSignalKeys: new Map(),
  initializedSignals: false,
  lastCountdownAlertKey: "",
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
function getSelectedPair() {
  return $("pairSelect")?.value || state.selectedPair;
}
function directionLabel(d) {
  return d === "CALL" ? "CALL ↑" : d === "PUT" ? "PUT ↓" : "STANDBY";
}
function formatPrice(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n >= 20 ? n.toFixed(3) : n.toFixed(5);
}
function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
async function fetchJSON(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`API ไม่ได้ส่ง JSON กลับมา (HTTP ${response.status})`);
    }
    if (!response.ok)
      throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("หมดเวลารอ API กรุณาลองอีกครั้ง");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

/* Sound: browser requires a user tap before enabling audio. */
async function enableSoundFromTap() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("เบราว์เซอร์นี้ไม่รองรับ Web Audio");
  if (!state.audioContext || state.audioContext.state === "closed")
    state.audioContext = new AudioContextClass();
  if (state.audioContext.state !== "running") await state.audioContext.resume();
  if (state.audioContext.state !== "running")
    throw new Error("เปิดเสียงไม่สำเร็จ กรุณาตรวจการตั้งค่าเสียง");
  state.soundEnabled = true;
  return true;
}
function playTone(frequency = 880, duration = 180, volume = 0.15) {
  const ctx = state.audioContext;
  if (!state.soundEnabled || !ctx || ctx.state !== "running") return false;
  try {
    const oscillator = ctx.createOscillator(),
      gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.025);
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
    console.warn("เล่นเสียงไม่สำเร็จ", error);
    return false;
  }
}
function playAlert(kind = "signal") {
  if (!state.soundEnabled) return;
  if (kind === "ten") {
    playTone(740, 180);
  } else if (kind === "two") {
    playTone(1046, 180);
    window.setTimeout(() => playTone(1318, 220), 220);
  } else {
    playTone(880, 180);
    window.setTimeout(() => playTone(1175, 220), 240);
  }
}
function vibrateDevice(pattern = [180, 100, 250]) {
  if (!state.vibrationEnabled) return false;
  if (typeof navigator.vibrate !== "function") return false;
  try {
    return navigator.vibrate(pattern);
  } catch (error) {
    console.warn("สั่นไม่สำเร็จ", error);
    return false;
  }
}

function signalKey(result) {
  return [
    result.pair || "",
    result.direction || "STANDBY",
    result.stage || "",
    result.signalId || "",
    result.candleTime || "",
  ].join("|");
}
function notifyNewSignal(result) {
  if (!result || !result.pair || !["CALL", "PUT"].includes(result.direction))
    return;
  const key = signalKey(result),
    previous = state.lastSignalKeys.get(result.pair);
  if (previous === key) return;
  state.lastSignalKeys.set(result.pair, key);
  if (
    !state.initializedSignals ||
    !state.notifications ||
    document.visibilityState !== "visible"
  )
    return;
  playAlert("signal");
  vibrateDevice();
}

async function loadConfig() {
  const data = await fetchJSON(API.config);
  state.config = data;
  const select = $("pairSelect");
  if (select && Array.isArray(data.pairs) && data.pairs.length) {
    const old = state.selectedPair;
    select.replaceChildren();
    for (const pair of data.pairs) {
      const opt = document.createElement("option");
      opt.value = pair;
      opt.textContent = pair;
      select.appendChild(opt);
    }
    select.value = data.pairs.includes(old) ? old : data.pairs[0];
    state.selectedPair = select.value;
  }
  return data;
}
async function loadHealth() {
  try {
    const data = await fetchJSON(API.health);
    setStatus(data.ok ? "เชื่อมต่อแล้ว" : "เซิร์ฟเวอร์มีปัญหา", !!data.ok);
    setText("errorText", data.lastError || "ไม่พบข้อผิดพลาดล่าสุด");
    return data;
  } catch (error) {
    setStatus("เชื่อมต่อไม่ได้", false);
    setText("errorText", error.message);
    return null;
  }
}

function renderReasons(result) {
  const list = $("reasons");
  if (!list) return;
  list.replaceChildren();
  const reasons =
    Array.isArray(result.reasons) && result.reasons.length
      ? result.reasons
      : ["ยังไม่มีเหตุผลสัญญาณเพิ่มเติม"];
  for (const reason of reasons) {
    const li = document.createElement("li");
    /* Clarify RSI is an individual indicator, not the final signal direction. */
    const str = String(reason)
      .replace(
        "RSI supports upward momentum",
        "RSI เอนเอียงไปทางแรงส่งขึ้น (เป็นเพียงหนึ่งตัวชี้วัด)"
      )
      .replace(
        "RSI supports downward momentum",
        "RSI เอนเอียงไปทางแรงส่งลง (เป็นเพียงหนึ่งตัวชี้วัด)"
      )
      .replace("EMA6 above EMA21", "EMA6 อยู่เหนือ EMA21")
      .replace("EMA6 below EMA21", "EMA6 อยู่ต่ำกว่า EMA21")
      .replace("EMA21 above EMA50", "EMA21 อยู่เหนือ EMA50")
      .replace("EMA21 below EMA50", "EMA21 อยู่ต่ำกว่า EMA50")
      .replace("MACD positive", "MACD เป็นบวก")
      .replace("MACD negative", "MACD เป็นลบ")
      .replace("Closed candle is green", "แท่งที่ปิดแล้วเป็นสีเขียว")
      .replace("Closed candle is red", "แท่งที่ปิดแล้วเป็นสีแดง")
      .replace("Forming candle is green", "แท่งที่กำลังก่อตัวเป็นสีเขียว")
      .replace("Forming candle is red", "แท่งที่กำลังก่อตัวเป็นสีแดง")
      .replace(
        "RSI extreme or neutral; use caution",
        "RSI อยู่ในโซนสุดโต่งหรือเป็นกลาง ควรระวัง"
      );
    li.textContent = str;
    list.appendChild(li);
  }
}
function renderSignal(result) {
  if (!result) return;
  const direction = result.direction || "STANDBY",
    stage = result.stage || "STANDBY";
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
      direction === "CALL" ? "call" : direction === "PUT" ? "put" : "standby"
    );
  }
  const bar = $("signalBar");
  if (bar) {
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    bar.style.width = `${score}%`;
  }
  setText("earlyDir", directionLabel(result.early?.direction));
  setText("earlyScore", `คะแนน ${result.early?.score ?? "—"}`);
  setText("confirmedDir", directionLabel(result.confirmed?.direction));
  setText("confirmedScore", `คะแนน ${result.confirmed?.score ?? "—"}`);
  renderReasons(result);
}
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
    meta.textContent = `${result.stage || "STANDBY"} · คะแนน ${ result.score ?? 0 }/100`;
    button.append(pair, signal, meta);
    button.classList.add(
      result.direction === "CALL"
        ? "call"
        : result.direction === "PUT"
        ? "put"
        : "standby"
    );
    button.addEventListener("click", () => {
      const select = $("pairSelect");
      if (select && [...select.options].some((o) => o.value === result.pair))
        select.value = result.pair;
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
    if (!result?.pair) continue;
    if (!state.lastSignalKeys.has(result.pair))
      state.lastSignalKeys.set(result.pair, signalKey(result));
    else notifyNewSignal(result);
  }
  renderRadar(results);
  const selected = results.find((r) => r?.pair === getSelectedPair());
  if (selected) renderSignal(selected);
  setText(
    "updated",
    `ข้อมูลเซิร์ฟเวอร์ ${formatTime(data.lastPollAt)} · หน้าจอ ${formatTime( new Date() )}`
  );
  setText("errorText", data.lastError || "ไม่พบข้อผิดพลาดล่าสุด");
  state.initializedSignals = true;
  return data;
}

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
    const data = await fetchJSON(
      `${API.scan}?pair=${encodeURIComponent(pair)}`,
      25000
    );
    if (data.result) {
      renderSignal(data.result);
      notifyNewSignal(data.result);
    } else setStatus("API ตอบกลับแล้ว แต่ไม่มีผลสแกน", false);
    if (Array.isArray(data.results)) renderRadar(data.results);
    setStatus(`สแกน ${data.scannedPair || pair} แล้ว`, true);
    setText("updated", `สแกนล่าสุด ${formatTime(new Date())}`);
    try {
      await loadRadar();
      setStatus(`เชื่อมต่อแล้ว · ${pair}`, true);
    } catch (error) {
      console.warn("โหลดเรดาร์ไม่สำเร็จ", error);
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
async function showDiagnostics() {
  const button = $("diagnosticsBtn"),
    output = $("diagnostics");
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

/* Device-clock countdown to the next minute boundary; not broker expiry sync. */
function updateCandleCountdown() {
  const clock = $("candleCountdown");
  if (!clock) return;
  const now = Date.now(),
    minuteKey = Math.floor(now / 60000),
    nextMinute = (minuteKey + 1) * 60000;
  const remaining = Math.max(0, Math.ceil((nextMinute - now) / 1000));
  clock.textContent = `00:${String(remaining % 60).padStart(2, "0")}`;
  clock.classList.toggle("urgent", remaining <= 10);
  setText("countdownPair", getSelectedPair());
  const note = $("countdownNote");
  if (note)
    note.textContent =
      remaining <= 10
        ? "ใกล้เปลี่ยนนาทีแล้ว · ตรวจกราฟ IQ Option ก่อนตัดสินใจ"
        : "นับตามนาฬิกาอุปกรณ์ ไม่ใช่เวลาหมดอายุออเดอร์ที่ยืนยันจาก IQ Option";
  if (
    document.visibilityState === "visible" &&
    state.notifications &&
    (remaining === 10 || remaining === 2)
  ) {
    const key = `${minuteKey}:${remaining}`;
    if (state.lastCountdownAlertKey !== key) {
      state.lastCountdownAlertKey = key;
      if (remaining === 10) {
        playAlert("ten");
        vibrateDevice([120, 70, 120]);
      } else {
        playAlert("two");
        vibrateDevice([180, 100, 250]);
      }
    }
  }
}
function startCandleCountdown() {
  if (state.countdownTimer) window.clearInterval(state.countdownTimer);
  updateCandleCountdown();
  state.countdownTimer = window.setInterval(updateCandleCountdown, 200);
}

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
      await enableSoundFromTap();
      if (button) button.textContent = "ปิดเสียง";
      playTone(880, 180);
      setStatus("เปิดเสียงแล้ว · ทดสอบเสียง");
    } catch (error) {
      setStatus(error.message, false);
    }
  });
  $("vibrateBtn")?.addEventListener("click", () => {
    if (typeof navigator.vibrate !== "function") {
      setStatus(
        "เบราว์เซอร์นี้ไม่รองรับการสั่น ลองเปิดด้วย Chrome บน Android",
        false
      );
      return;
    }
    state.vibrationEnabled = true;
    const success = navigator.vibrate([250, 120, 250]);
    if (success) {
      $("vibrateBtn").textContent = "เปิดใช้งานสั่นแล้ว";
      setStatus("ส่งคำสั่งสั่นแล้ว");
    } else setStatus("อุปกรณ์หรือเบราว์เซอร์ปฏิเสธคำสั่งสั่น", false);
  });
  $("pairSelect")?.addEventListener("change", () => {
    state.selectedPair = getSelectedPair();
    setStatus(`เลือก ${state.selectedPair} แล้ว`);
    scanSelectedPair();
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
      state.notifications ? "เปิดการแจ้งเตือนแล้ว" : "ปิดการแจ้งเตือนแล้ว"
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
      loadRadar().catch(console.warn);
      loadHealth();
    }
  });
}
function startAutoRefresh() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
  if (!state.autoRefresh) return;
  const configured = Number(state.config?.pollIntervalMs || 15000);
  const interval = Math.max(5000, Math.min(configured, 30000));
  state.refreshTimer = window.setInterval(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      await loadRadar();
    } catch (error) {
      console.warn("Auto refresh failed", error);
      setStatus("กำลังรอการเชื่อมต่อใหม่", false);
    }
  }, interval);
}
async function init() {
  bindControls();
  startCandleCountdown();
  setStatus("กำลังเชื่อมต่อ...");
  try {
    await loadConfig();
    await loadHealth();
    await loadRadar();
    startAutoRefresh();
    scanSelectedPair().catch(console.error);
  } catch (error) {
    console.error("Startup error", error);
    setStatus(`เริ่มระบบไม่สำเร็จ: ${error.message}`, false);
    setText("errorText", error.message);
  }
}
if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", init, { once: true });
else init();