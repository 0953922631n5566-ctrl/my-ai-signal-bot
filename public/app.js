
"use strict";

const $ = id => document.getElementById(id);

const state = {
  marketMode: "NON_OTC",
  sound: false,
  vibrate: false,
  audioContext: null,
  loading: false,
  latestData: null,
  activeDirection: "STANDBY",
  activeUntil: 0,
  lastSignalMinute: null,
  warning10Minute: null,
  warning2Minute: null
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

async function refreshDashboard() {
  if (state.loading) return;
  state.loading = true;
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "กำลังตรวจสอบ…";

  try {
    if (state.marketMode === "SCREEN") {
      const data = await getJson("/api/screen/status");
      state.latestData = data;
      const connected = data.dataFresh === true && !data.error &&
        data.price !== null && data.price !== undefined;
      const heading = document.querySelector(".market-heading h2");
      const subtitle = document.querySelector(".market-heading p");
      if (heading) heading.textContent = data.symbol || "8xTrade · รอข้อมูล";
      if (subtitle) subtitle.textContent = "8xTrade · อ่านจากหน้าจอ · 1 นาที";
      $("marketModeNote").textContent = "โหมด 8xTrade อ่านข้อมูล OCR จากหน้าจอที่คุณอนุญาต";
      if (connected) {
        setConnection(true, "ได้รับข้อมูลจากหน้าจอ 8xTrade");
        hideNotice();
      } else {
        setConnection(false, "รอข้อมูลหน้าจอ 8xTrade");
        showNotice(
          "ข้อมูลหน้าจอยังไม่พร้อม",
          data.reason || data.error || "เปิดแอป Android Companion และตรวจสอบราคา OCR"
        );
      }
      renderSignal(data);
      return;
    }

    const [health, data] = await Promise.all([
      getJson("/api/health"),
      getJson("/api/status")
    ]);
    state.latestData = data;
    const connected =
      health.apiKeyConfigured === true &&
      data.dataFresh === true &&
      !data.error &&
      data.price !== null &&
      data.price !== undefined;
    if (connected) {
      setConnection(true, "เชื่อมต่อข้อมูลตลาดแล้ว");
      hideNotice();
    } else {
      setConnection(false, "ข้อมูลตลาดมีปัญหา");
      showNotice(
        "ตรวจพบปัญหาข้อมูลตลาด",
        health.error || data.error ||
          (!health.apiKeyConfigured
            ? "ตั้งค่า TWELVE_DATA_API_KEY ใน Render Environment Variables"
            : "ข้อมูลยังไม่พร้อม รอข้อมูลใหม่")
      );
    }
    const heading = document.querySelector(".market-heading h2");
    if (heading) heading.textContent = data.symbol || "EUR/USD";
    $("marketModeNote").textContent = "ตลาดหลักใช้ข้อมูล Twelve Data";
    const subtitle = document.querySelector(".market-heading p");
    if (subtitle) subtitle.textContent = "ตลาดหลัก · 1 นาที · Twelve Data";
    renderSignal(data);
  } catch (error) {
    setConnection(false, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
    showNotice(
      "การเชื่อมต่อขัดข้อง",
      error.name === "AbortError"
        ? "เซิร์ฟเวอร์ตอบช้าเกินกำหนด ลองใหม่อีกครั้ง"
        : error.message || "ตรวจสอบสถานะ Render"
    );
    state.latestData = null;
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;
    renderSignal({
      candidate: "STANDBY",
      dataFresh: false,
      score: 0,
      price: null,
      reason: "ไม่สามารถยืนยันข้อมูลตลาดได้"
    });
  } finally {
    state.loading = false;
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "สแกนข้อมูลอีกครั้ง";
  }
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
    await getJson("/api/scan", 20000);
  } catch (error) {
    showNotice("สแกนไม่สำเร็จ", error.message || "กำลังรอข้อมูลตลาด");
  }

  await refreshDashboard();
});

$("nonOtcBtn").addEventListener("click", () => {
  state.marketMode = "NON_OTC";
  $("nonOtcBtn").classList.add("active");
  $("otcBtn").classList.remove("active");
  state.activeDirection = "STANDBY";
  state.activeUntil = 0;
  refreshDashboard();
});

$("otcBtn").addEventListener("click", () => {
  state.marketMode = "SCREEN";
  $("otcBtn").classList.add("active");
  $("nonOtcBtn").classList.remove("active");
  state.activeDirection = "STANDBY";
  state.activeUntil = 0;
  refreshDashboard();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDashboard();
});

updateCountdown();
setInterval(updateCountdown, 200);
refreshDashboard();
setInterval(refreshDashboard, 5000);
