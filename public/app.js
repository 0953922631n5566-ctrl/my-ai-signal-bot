"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  sound: false,
  vibrate: false,
  audioContext: null,
  lastDirection: null,
  lastAlertMinute: null,
  warning10Minute: null,
  warning2Minute: null,
  loading: false,
  lastSuccessfulHealth: false
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
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
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
  const direction = ["CALL", "PUT", "STANDBY"].includes(data.direction)
    ? data.direction
    : "STANDBY";

  $("signalCard").classList.remove("call", "put", "standby");
  $("signalCard").classList.add(direction.toLowerCase());

  $("signalTitle").textContent = direction;
  $("signalArrow").textContent =
    direction === "CALL" ? "↑" :
    direction === "PUT" ? "↓" : "●";

  $("signalMessage").textContent = data.note || "รอข้อมูลรอบถัดไป";

  const score = Number(data.score);
  const safeScore = Number.isFinite(score)
    ? Math.max(0, Math.min(100, score))
    : 0;

  $("score").textContent = `${safeScore}%`;
  $("scoreBar").style.width = `${safeScore}%`;

  $("price").textContent = formatNumber(data.price, 5);

  const indicators = data.indicators || {};
  $("ema9").textContent = formatNumber(indicators.ema9, 5);
  $("ema21").textContent = formatNumber(indicators.ema21, 5);
  $("rsi14").textContent = formatNumber(indicators.rsi14, 2);
  $("macd").textContent = formatNumber(indicators.macd, 6);

  $("lastUpdated").textContent = formatTime(data.updatedAt);

  // แจ้งเตือนเมื่อทิศทางเปลี่ยนจาก STANDBY ไปเป็น CALL/PUT
  // หรือเปลี่ยนจาก CALL เป็น PUT และกลับกัน
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

    state.lastSuccessfulHealth = connected;

    if (connected) {
      setConnection(true, "เชื่อมต่อข้อมูลตลาดแล้ว");
      hideNotice();
    } else {
      setConnection(false, "ข้อมูลตลาดมีปัญหา");
      showNotice(
        "ไม่สามารถยืนยันข้อมูลตลาดได้",
        health.error ||
          data.error ||
          (!health.apiKeyConfigured
            ? "กรุณาตั้งค่า TWELVE_DATA_API_KEY ใน Render Environment"
            : "รอข้อมูลตลาดที่ใหม่และถูกต้องก่อนใช้งาน")
      );
    }

    renderSignal(data);

    if (health.lastSuccessAt) {
      $("lastUpdated").textContent = formatTime(health.lastSuccessAt);
    }
  } catch (error) {
    state.lastSuccessfulHealth = false;
    setConnection(false, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");

    showNotice(
      "การเชื่อมต่อขัดข้อง",
      error.name === "AbortError"
        ? "เซิร์ฟเวอร์ตอบช้าเกินเวลาที่กำหนด ลองใหม่อีกครั้ง"
        : error.message || "ตรวจสอบ URL และสถานะ Render"
    );
  } finally {
    state.loading = false;
    $("refreshBtn").disabled = false;
    $("refreshBtn").textContent = "สแกนข้อมูลอีกครั้ง";
  }
}

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

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
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.setValueAtTime(
      0.15,
      ctx.currentTime + durationMs / 1000 - 0.03
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + durationMs / 1000
    );

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + durationMs / 1000);
  } catch (error) {
    console.warn("เล่นเสียงไม่ได้:", error.message);
  }
}

function vibrate(pattern) {
  if (!state.vibrate) return;
  if (typeof navigator.vibrate !== "function") return;

  try {
    navigator.vibrate(pattern);
  } catch (error) {
    console.warn("อุปกรณ์ไม่รองรับการสั่น");
  }
}

function updateCountdown() {
  const now = new Date();
  const millisecondsIntoMinute =
    now.getSeconds() * 1000 + now.getMilliseconds();

  const remainingMs = 60000 - millisecondsIntoMinute;
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  $("countdown").textContent =
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  $("countdownMessage").textContent =
    "อ้างอิงนาฬิกาอุปกรณ์ ไม่ใช่เวลาหมดอายุที่ยืนยันจาก IQ Option";

  $("countdownCard")?.classList.toggle(
    "warning",
    remainingSeconds <= 10
  );

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

  if (remainingSeconds === 60) {
    state.warning10Minute = null;
    state.warning2Minute = null;
  }
}

$("soundBtn").addEventListener("click", async () => {
  state.sound = !state.sound;

  if (state.sound) {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") await ctx.resume();
      await playBeep(720, 100);
    } catch (_) {
      // แสดงสถานะเปิดเสียงไว้ แต่เบราว์เซอร์อาจบล็อกเสียง
    }
  }

  $("soundBtn").textContent = state.sound ? "ปิดเสียง" : "เปิดเสียง";
  $("soundBtn").classList.toggle("active", state.sound);
});

$("vibrateBtn").addEventListener("click", () => {
  state.vibrate = !state.vibrate;

  $("vibrateBtn").textContent = state.vibrate ? "ปิดสั่น" : "เปิดสั่น";
  $("vibrateBtn").classList.toggle("active", state.vibrate);

  if (state.vibrate) {
    vibrate([100]);
  }
});

$("refreshBtn").addEventListener("click", async () => {
  try {
    await getJson("/api/scan", 20000);
  } catch (error) {
    showNotice("สแกนไม่สำเร็จ", error.message || "ลองใหม่อีกครั้ง");
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