
"use strict";

const $ = id => document.getElementById(id);

const state = {
  sound: false,
  vibrate: false,
  audioContext: null,
  loading: false,
  latestData: null,
  activeDirection: "STANDBY",
  activeUntil: 0,
  lastSignalMinute: null,
  warning10Minute: null,
  warning2Minute: null,
  activeMode: "B",
  screenStatus: null
};

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

function showNotice(title, message) {
  $("noticeTitle").textContent = title;
  $("noticeText").textContent = message;
  $("notice").classList.remove("hidden");
}

function hideNotice() {
  $("notice").classList.add("hidden");
}

function setConnection(online, text) {
  $("connectionDot").className = online ? "dot online" : "dot offline";
  $("connectionText").textContent = text;
}

function formatNumber(value, digits = 5) {
  if (value === null || value === undefined || value === "" ||
      !Number.isFinite(Number(value))) {
    return "--";
  }

  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatTime(value) {
  if (!value) return "รอข้อมูล";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "รอข้อมูล";

  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!state.audioContext) state.audioContext = new AudioContextClass();
  return state.audioContext;
}

async function playBeep(frequency = 760, durationMs = 180) {
  if (!state.sound) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const duration = durationMs / 1000;

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.setValueAtTime(
      0.15,
      ctx.currentTime + Math.max(0.025, duration - 0.03)
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + duration
    );

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
  } catch (error) {
    console.warn("เล่นเสียงไม่ได้:", error.message);
  }
}

function vibrate(pattern) {
  if (!state.vibrate || typeof navigator.vibrate !== "function") return;

  try {
    navigator.vibrate(pattern);
  } catch (error) {
    console.warn("อุปกรณ์ไม่รองรับการสั่น");
  }
}

async function getJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `เซิร์ฟเวอร์ตอบกลับ ${response.status}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function renderSignal(data) {
  const now = Date.now();

  let direction = "STANDBY";
  let message = data.reason || "กำลังรอข้อมูลรอบถัดไป";

  if (
    state.activeUntil > now &&
    ["CALL", "PUT"].includes(state.activeDirection) &&
    data.dataFresh === true &&
    !data.error
  ) {
    direction = state.activeDirection;
    message = direction === "CALL"
      ? "สัญญาณ CALL · แสดงไม่เกิน 40 วินาที"
      : "สัญญาณ PUT · แสดงไม่เกิน 40 วินาที";
  } else {
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;

    if (data.error) message = data.error;
    else if (data.dataFresh !== true) message = "ข้อมูลเก่าหรือไม่พร้อม รอข้อมูลใหม่";
    else if (data.candidate === "STANDBY") message = data.reason || "สัญญาณยังไม่ชัดเจน";
    else message = "รอจังหวะยืนยันสัญญาณที่ 2 วินาทีสุดท้าย";
  }

  const card = $("signalCard");
  card.classList.remove("call", "put", "standby");
  card.classList.add(direction.toLowerCase());

  $("signalTitle").textContent = direction;
  $("signalArrow").textContent =
    direction === "CALL" ? "↑" :
    direction === "PUT" ? "↓" : "●";

  $("signalMessage").textContent = message;

  const score = direction === "STANDBY"
    ? 0
    : Math.max(0, Math.min(100, Number(data.score) || 0));

  $("score").textContent = `${score}%`;
  $("scoreBar").style.width = `${score}%`;

  $("price").textContent = formatNumber(data.price, 5);
  $("ema9").textContent = formatNumber(data.ema9, 5);
  $("ema21").textContent = formatNumber(data.ema21, 5);
  $("rsi14").textContent = formatNumber(data.rsi14, 2);
  $("macd").textContent = formatNumber(data.macd, 6);
  $("lastUpdated").textContent = formatTime(data.fetchedAt || data.lastPollAt);

  const pairHeading = document.querySelector(".market-heading h2");
  if (pairHeading && data.symbol) pairHeading.textContent = data.symbol;
}

function clearSignalToStandby(message) {
  state.activeDirection = "STANDBY";
  state.activeUntil = 0;
  const card = $("signalCard");
  card.classList.remove("call", "put");
  card.classList.add("standby");
  $("signalTitle").textContent = "STANDBY";
  $("signalArrow").textContent = "●";
  $("signalMessage").textContent = message;
  $("score").textContent = "--";
  $("scoreBar").style.width = "0%";
}

function renderScreenMode(data) {
  state.screenStatus = data;
  const tick = data && data.dataFresh === true ? data.tick : null;
  const fresh = Boolean(tick && Number.isFinite(Number(tick.price)));

  $("marketSource").textContent = "หน้าจอ 8xTrade · Android OCR";
  $("price").textContent = fresh ? formatNumber(tick.price, 5) : "--";
  $("ema9").textContent = "--";
  $("ema21").textContent = "--";
  $("rsi14").textContent = "--";
  $("macd").textContent = "--";
  $("lastUpdated").textContent = fresh ? formatTime(tick.capturedAt) : "ไม่มีข้อมูลสด";
  const pairHeading = document.querySelector(".market-heading h2");
  if (pairHeading) pairHeading.textContent = fresh ? tick.symbol : "รอหน้าจอ";

  if (fresh) {
    setConnection(true, "รับข้อมูล OCR จากหน้าจอ");
    const confidence = Number.isFinite(Number(tick.confidence))
      ? ` · ความเชื่อมั่น OCR ${Math.round(Number(tick.confidence) * 100)}%`
      : "";
    $("modeDescription").textContent = "โหมด A ทำงานอยู่ — ใช้ข้อมูลจากหน้าจอ 8xTrade เท่านั้น";
    showNotice(
      "อ่านหน้าจอได้ แต่ยังไม่มีสัญญาณจากโหมด A",
      "ขณะนี้ระบบรับคู่เงินและราคา OCR ได้เท่านั้น ยังไม่ได้แปลงข้อมูลนี้เป็นแท่งเทียนเพื่อคำนวณ CALL/PUT จึงแสดง STANDBY เพื่อไม่สร้างสัญญาณที่ไม่มีหลักฐาน" + confidence
    );
    clearSignalToStandby("รับราคา OCR แล้ว แต่ยังไม่มีเครื่องคำนวณสัญญาณจากแท่งเทียนของโหมด A");
  } else {
    setConnection(false, "รอข้อมูลจากหน้าจอ 8xTrade");
    $("modeDescription").textContent = "โหมด A ทำงานอยู่ — ต้องเปิดแอปคู่หู Android และอนุญาตอ่านหน้าจอ";
    showNotice(
      "ยังไม่ได้รับข้อมูลหน้าจอ",
      "ตรวจสอบว่า Android companion กำลังอ่านหน้าจอที่อนุญาต และส่งข้อมูลไปยังเซิร์ฟเวอร์ ข้อมูลที่เกิน 15 วินาทีจะไม่แสดง"
    );
    clearSignalToStandby("ไม่มีราคา OCR ที่สดพอ จึงไม่แสดงสัญญาณ");
  }
}

async function refreshDashboard() {
  if (state.loading) return;

  const requestedMode = state.activeMode;
  state.loading = true;
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "กำลังตรวจสอบ…";

  try {
    if (requestedMode === "A") {
      const screen = await getJson("/api/screen/status");
      if (state.activeMode !== requestedMode) return;
      state.latestData = null;
      renderScreenMode(screen);
      return;
    }

    const [health, data] = await Promise.all([
      getJson("/api/health"),
      getJson("/api/status")
    ]);
    if (state.activeMode !== requestedMode) return;

    state.latestData = data;
    const connected =
      health.apiKeyConfigured === true &&
      data.dataFresh === true &&
      !data.error &&
      data.price !== null &&
      data.price !== undefined;

    $("marketSource").textContent = "ตลาดหลัก · 1 นาที · Twelve Data";
    $("modeDescription").textContent = "โหมด B ทำงานอยู่ — ใช้ข้อมูลตลาดหลักจาก Twelve Data เท่านั้น";

    if (connected) {
      setConnection(true, "เชื่อมต่อข้อมูลตลาดแล้ว");
      hideNotice();
    } else {
      setConnection(false, "ข้อมูลตลาดมีปัญหา");
      showNotice(
        "ตรวจพบปัญหาข้อมูลตลาด",
        health.error ||
          data.error ||
          (!health.apiKeyConfigured
            ? "ตั้งค่า TWELVE_DATA_API_KEY ใน Render Environment Variables"
            : "ข้อมูลยังไม่พร้อม รอข้อมูลใหม่")
      );
    }
    renderSignal(data);
  } catch (error) {
    if (state.activeMode !== requestedMode) return;
    setConnection(false, "เชื่อมต่อแหล่งข้อมูลไม่ได้");
    showNotice(
      "การเชื่อมต่อขัดข้อง",
      error.name === "AbortError"
        ? "เซิร์ฟเวอร์ตอบช้าเกินกำหนด ลองใหม่อีกครั้ง"
        : error.message || "ตรวจสอบสถานะ Render และการเชื่อมต่อ"
    );

    state.latestData = null;
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;

    if (requestedMode === "A") {
      renderScreenMode({ dataFresh: false, tick: null });
    } else {
      renderSignal({
        candidate: "STANDBY",
        dataFresh: false,
        score: 0,
        price: null,
        reason: "ไม่สามารถยืนยันข้อมูลตลาดได้"
      });
    }
  } finally {
    state.loading = false;
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "สแกนข้อมูลอีกครั้ง";
  }
}

function setMode(mode) {
  if (!["A", "B"].includes(mode) || state.activeMode === mode) return;

  state.activeMode = mode;
  state.latestData = null;
  state.screenStatus = null;
  state.activeDirection = "STANDBY";
  state.activeUntil = 0;
  state.lastSignalMinute = null;
  state.warning10Minute = null;
  state.warning2Minute = null;

  $("modeABtn").classList.toggle("active", mode === "A");
  $("modeBBtn").classList.toggle("active", mode === "B");
  $("modeABtn").setAttribute("aria-pressed", String(mode === "A"));
  $("modeBBtn").setAttribute("aria-pressed", String(mode === "B"));
  $("indicatorsCard").classList.toggle("hidden", mode === "A");
  $("countdownCard").classList.toggle("hidden", mode === "A");

  clearSignalToStandby(mode === "A"
    ? "กำลังตรวจสอบข้อมูล OCR ของโหมด A"
    : "กำลังตรวจสอบข้อมูลตลาดของโหมด B");
  $("price").textContent = "--";
  $("lastUpdated").textContent = "รอข้อมูล";
  $("marketSource").textContent = mode === "A"
    ? "หน้าจอ 8xTrade · Android OCR"
    : "ตลาดหลัก · 1 นาที · Twelve Data";
  $("modeDescription").textContent = mode === "A"
    ? "กำลังใช้ข้อมูลจากหน้าจอ 8xTrade เท่านั้น"
    : "กำลังใช้ข้อมูลตลาดหลักจาก Twelve Data เท่านั้น";
  hideNotice();
  refreshDashboard();
}

function minuteKey(date) {
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes()
  ].join("-");
}

function triggerSignalAtTwoSeconds(key) {
  if (state.activeMode !== "B") return;
  if (state.lastSignalMinute === key) return;
  state.lastSignalMinute = key;

  const data = state.latestData;

  if (
    !data ||
    data.dataFresh !== true ||
    data.error ||
    !Number.isFinite(Number(data.score)) ||
    Number(data.score) < Number(data.minScore || 70) ||
    !["CALL", "PUT"].includes(data.candidate)
  ) {
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;
    if (data) renderSignal(data);
    return;
  }

  state.activeDirection = data.candidate;
  state.activeUntil = Date.now() + Number(data.signalDurationMs || 40000);

  renderSignal(data);

  playBeep(data.candidate === "CALL" ? 1050 : 480, 320);
  vibrate([180, 70, 180]);
}

function updateCountdown() {
  if (state.activeMode !== "B") return;
  const now = new Date();
  const elapsed = now.getSeconds() * 1000 + now.getMilliseconds();
  const remainingMs = 60000 - elapsed;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  $("countdown").textContent =
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  $("countdownMessage").textContent =
    "อ้างอิงนาฬิกาอุปกรณ์ ไม่ใช่เวลาหมดอายุที่ยืนยันจาก IQ Option";

  $("countdownCard").classList.toggle("warning", remainingSeconds <= 10);

  const key = minuteKey(now);

  // Trigger when crossing the threshold, not only at exact equality.
  // Mobile browsers may delay timers, so exact-second checks can be missed.
  if (remainingMs <= 10000 && remainingMs > 0 && state.warning10Minute !== key) {
    state.warning10Minute = key;
    playBeep(650, 220);
    vibrate([160]);
  }

  if (remainingMs <= 2000 && remainingMs > 0 && state.warning2Minute !== key) {
    state.warning2Minute = key;
    triggerSignalAtTwoSeconds(key);
  }

  if (state.activeUntil && Date.now() >= state.activeUntil) {
    state.activeUntil = 0;
    state.activeDirection = "STANDBY";
    if (state.latestData) renderSignal(state.latestData);
  }
}

$("modeABtn").addEventListener("click", () => setMode("A"));
$("modeBBtn").addEventListener("click", () => setMode("B"));

$("soundBtn").addEventListener("click", async () => {
  state.sound = !state.sound;

  if (state.sound) {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") await ctx.resume();
      await playBeep(720, 100);
    } catch (error) {
      console.warn("เปิดเสียงไม่ได้:", error.message);
    }
  }

  $("soundBtn").textContent = state.sound ? "ปิดเสียง" : "เปิดเสียง";
  $("soundBtn").classList.toggle("active", state.sound);
});

$("vibrateBtn").addEventListener("click", () => {
  state.vibrate = !state.vibrate;
  $("vibrateBtn").textContent = state.vibrate ? "ปิดสั่น" : "เปิดสั่น";
  $("vibrateBtn").classList.toggle("active", state.vibrate);
  if (state.vibrate) vibrate([100]);
});

$("refreshBtn").addEventListener("click", async () => {
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "กำลังสแกน…";

  try {
    if (state.activeMode === "B") await getJson("/api/scan", 20000);
  } catch (error) {
    showNotice("สแกนไม่สำเร็จ", error.message || "กำลังรอข้อมูลตลาด");
  }

  await refreshDashboard();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDashboard();
});

$("indicatorsCard").classList.toggle("hidden", state.activeMode === "A");
$("countdownCard").classList.toggle("hidden", state.activeMode === "A");
updateCountdown();
setInterval(updateCountdown, 200);
refreshDashboard();
setInterval(refreshDashboard, 5000);
