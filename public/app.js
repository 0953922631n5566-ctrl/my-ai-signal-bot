
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  sound: false,
  vibrate: false,
  audioContext: null,
  lastDirection: null,
  loading: false
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
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
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

function renderSignal(data) {
  let direction = ["CALL", "PUT", "STANDBY"].includes(data.direction)
    ? data.direction
    : "STANDBY";

  // ป้องกันการแสดงสัญญาณเข้าออเดอร์เมื่อข้อมูลเก่าหรือหมดอายุ
  if (data.dataStale === true) {
    direction = "STANDBY";
  }

  if (direction !== "STANDBY" && data.signalExpiresAt) {
    const expiry = new Date(data.signalExpiresAt).getTime();

    if (!Number.isFinite(expiry) || Date.now() >= expiry) {
      direction = "STANDBY";
    }
  }

  const card = $("signalCard");
  card.classList.remove("call", "put", "standby");
  card.classList.add(direction.toLowerCase());

  $("signalTitle").textContent = direction;
  $("signalArrow").textContent =
    direction === "CALL" ? "↑" :
    direction === "PUT" ? "↓" : "●";

  let message = data.note || "กำลังรอข้อมูลรอบถัดไป";

  if (direction === "STANDBY" && data.error) {
    message = "ข้อมูลมีปัญหา จึงพักสัญญาณไว้ก่อน";
  } else if (direction === "STANDBY" && data.dataStale) {
    message = "ข้อมูลเก่าเกินกำหนด รอข้อมูลใหม่";
  } else if (
    direction === "STANDBY" &&
    data.signalAt &&
    data.signalExpiresAt &&
    Date.now() >= new Date(data.signalExpiresAt).getTime()
  ) {
    message = "สัญญาณหมดอายุแล้ว รอประเมินรอบใหม่";
  }

  $("signalMessage").textContent = message;

  // คะแนน 0 เมื่อ STANDBY เพื่อไม่ให้เข้าใจว่าเป็นสัญญาณที่ยังใช้ได้
  const scoreValue = direction === "STANDBY" ? 0 : Number(data.score);
  const safeScore = Number.isFinite(scoreValue)
    ? Math.max(0, Math.min(100, scoreValue))
    : 0;

  $("score").textContent = `${safeScore}%`;
  $("scoreBar").style.width = `${safeScore}%`;

  $("price").textContent = formatNumber(data.price, 5);

  const indicators = data.indicators || {};
  $("ema9").textContent = formatNumber(indicators.ema9, 5);
  $("ema21").textContent = formatNumber(indicators.ema21, 5);
  $("rsi14").textContent = formatNumber(indicators.rsi14, 2);
  $("macd").textContent = formatNumber(indicators.macd, 6);

  $("lastUpdated").textContent = formatTime(data.lastSuccessAt || data.updatedAt);

  // แจ้งเตือนเฉพาะเมื่อมีสัญญาณใหม่หรือทิศทางเปลี่ยน
  if (
    state.lastDirection !== null &&
    direction !== state.lastDirection &&
    (direction === "CALL" || direction === "PUT")
  ) {
    playBeep(880, 250);
    vibrate([180, 80, 180]);
  }

  state.lastDirection = direction;
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

    if (!response.ok && response.status !== 503) {
      throw new Error(data.error || `เซิร์ฟเวอร์ตอบกลับ ${response.status}`);
    }

    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshDashboard() {
  if (state.loading) return;

  state.loading = true;
  $("refreshBtn").disabled = true;
  $("refreshBtn").textContent = "กำลังตรวจสอบ…";

  try {
    const [healthResult, statusResult] = await Promise.all([
      getJson("/api/health"),
      getJson("/api/status")
    ]);

    const health = healthResult.data;
    const data = statusResult.data;

    const connected =
      health.ok === true &&
      health.apiKeyConfigured === true &&
      !health.error &&
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
        health.error ||
          data.error ||
          (!health.apiKeyConfigured
            ? "กรุณาตั้งค่า TWELVE_DATA_API_KEY ใน Render"
            : "กำลังรอข้อมูลตลาดที่พร้อมใช้งาน")
      );
    }

    renderSignal(data);
  } catch (error) {
    setConnection(false, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");

    showNotice(
      "การเชื่อมต่อขัดข้อง",
      error.name === "AbortError"
        ? "เซิร์ฟเวอร์ตอบช้าเกินกำหนด ลองใหม่อีกครั้ง"
        : error.message || "ตรวจสอบ URL และสถานะ Render"
    );

    // หากติดต่อเซิร์ฟเวอร์ไม่ได้ ให้ดับสัญญาณเข้าออเดอร์
    renderSignal({
      direction: "STANDBY",
      score: 0,
      price: null,
      note: "ไม่สามารถยืนยันข้อมูลตลาดได้",
      indicators: {}
    });
  } finally {
    state.loading = false;
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "สแกนข้อมูลอีกครั้ง";
  }
}

function getAudioContext() {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) return null;

  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
  }

  return state.audioContext;
}

async function playBeep(frequency = 760, durationMs = 180) {
  if (!state.sound) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = frequency;

    const duration = durationMs / 1000;
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
  if (!state.vibrate || typeof navigator.vibrate !== "function") {
    return;
  }

  try {
    navigator.vibrate(pattern);
  } catch (error) {
    console.warn("อุปกรณ์ไม่รองรับการสั่น");
  }
}

function updateCountdown() {
  const now = new Date();
  const msIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds();
  const remainingMs = 60000 - msIntoMinute;
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  $("countdown").textContent =
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  $("countdownMessage").textContent =
    "อ้างอิงนาฬิกาอุปกรณ์ ไม่ใช่เวลาหมดอายุที่ยืนยันจาก IQ Option";

  $("countdownCard").classList.toggle(
    "warning",
    remainingSeconds <= 10
  );

  // ใช้เลขนาทีเป็นกุญแจ ป้องกันการเตือนซ้ำหลายครั้งในนาทีเดียว
  const minuteKey =
    `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

  if (remainingSeconds === 10 && state.warning10Minute !== minuteKey) {
    state.warning10Minute = minuteKey;
    playBeep(650, 180);
    vibrate([120]);
  }

  if (remainingSeconds === 2 && state.warning2Minute !== minuteKey) {
    state.warning2Minute = minuteKey;
    playBeep(1050, 250);
    vibrate([180, 70, 180]);
  }
}

state.warning10Minute = null;
state.warning2Minute = null;

$("soundBtn").addEventListener("click", async () => {
  state.sound = !state.sound;

  if (state.sound) {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        await ctx.resume();
      }

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
    showNotice(
      "สแกนไม่สำเร็จ",
      error.message || "กำลังรอข้อมูลตลาดจากเซิร์ฟเวอร์"
    );
  }

  await refreshDashboard();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshDashboard();
  }
});

updateCountdown();
setInterval(updateCountdown, 200);

refreshDashboard();
setInterval(refreshDashboard, 5000);
