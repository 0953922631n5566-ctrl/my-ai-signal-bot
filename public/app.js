
'use strict';

const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor?.('#080d18');
  tg.setBackgroundColor?.('#080d18');
}

const $ = id => document.getElementById(id);

const state = {
  running: true,
  soundEnabled: false,
  busy: false,
  current: null,
  activeSignal: 'STANDBY',
  signalExpiresAt: 0,
  lastWarningMinute: null,
  lastEntryMinute: null,
  audioContext: null,
  lastStatus: null,
  lastSignalCandle: null
};

const HOLD_SECONDS = 40;
const WARNING_SECONDS = 10;
const ENTRY_SECONDS = 5;
const MAX_DATA_AGE_SECONDS = 75;

function headers() {
  const result = {};
  if (tg?.initData) {
    result['x-telegram-init-data'] = tg.initData;
  }
  return result;
}

async function getJSON(url) {
  const response = await fetch(url, {
    headers: headers(),
    cache: 'no-store'
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (${response.status})`);
  }

  if (response.status === 401 || data.code === 'AUTH_REQUIRED') {
    throw new Error('กรุณาเปิด Mini App ผ่านปุ่มใน Telegram');
  }

  if (!response.ok) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }

  return data;
}

function formatTime(value) {
  if (!value) return '--';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';

  return date.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatPrice(value) {
  if (!Number.isFinite(Number(value))) return '--';

  const n = Number(value);
  return n >= 100 ? n.toFixed(3) : n.toFixed(5);
}

function alertBox(title, message) {
  $('alertBox').classList.remove('hidden');
  $('alertTitle').textContent = title;
  $('alertMessage').textContent = message;
}

function clearAlert() {
  $('alertBox').classList.add('hidden');
}

function connection(ready, text) {
  $('connectionDot').className = `dot ${ready ? 'good' : 'bad'}`;
  $('connectionText').textContent = text;
}

function standby(reason = 'รอสัญญาณรอบถัดไป') {
  state.activeSignal = 'STANDBY';
  state.signalExpiresAt = 0;

  $('signalCard').className = 'signal-card standby';
  $('signalText').textContent = 'STANDBY';
  $('signalArrow').textContent = '●';
  $('signalScore').textContent = 'Score --';
  $('signalReason').textContent = reason;
}

function showSignal(signal, score, reason) {
  const isCall = signal === 'CALL';

  state.activeSignal = signal;
  state.signalExpiresAt = Date.now() + HOLD_SECONDS * 1000;

  $('signalCard').className = `signal-card ${isCall ? 'call' : 'put'}`;
  $('signalText').textContent = signal;
  $('signalArrow').textContent = isCall ? '↑' : '↓';
  $('signalScore').textContent = `Score ${score}`;
  $('signalReason').textContent = reason || 'ผ่านเงื่อนไขวิเคราะห์';
}

function setDataState(code, message, fresh) {
  const labels = {
    OK: 'LIVE DATA',
    API_LIMIT: 'API LIMIT',
    DATA_STALE: 'DATA STALE',
    WAITING: 'WAITING',
    CONFIG_ERROR: 'CONFIG ERROR',
    AUTH_REQUIRED: 'AUTH REQUIRED'
  };

  $('dataStatus').textContent = labels[code] || code || 'UNKNOWN';
  connection(fresh, fresh ? 'ข้อมูลพร้อม' : 'ข้อมูลไม่พร้อม');

  if (!fresh) {
    standby(message || 'ข้อมูลไม่สด — หยุดสัญญาณใหม่');
    if (message) alertBox($('dataStatus').textContent, message);
  } else {
    clearAlert();
  }
}

function renderIndicators(data) {
  const i = data.indicators || {};

  $('priceValue').textContent = formatPrice(data.price);
  $('candleTime').textContent = formatTime(data.candleTime);
  $('dataAge').textContent = Number.isFinite(data.dataAgeSeconds)
    ? `${data.dataAgeSeconds} วินาทีหลังแท่งปิด`
    : '--';

  $('updatedAt').textContent =
    `รับข้อมูลล่าสุด ${formatTime(data.fetchedAt)}`;

  $('rsiValue').textContent = Number.isFinite(i.rsi)
    ? Number(i.rsi).toFixed(1)
    : '--';

  $('macdValue').textContent = Number.isFinite(i.macd)
    ? Number(i.macd).toPrecision(4)
    : '--';

  if (
    Number.isFinite(i.ema8) &&
    Number.isFinite(i.ema21) &&
    Number.isFinite(i.ema50)
  ) {
    $('trendValue').textContent =
      i.ema8 > i.ema21 && i.ema21 > i.ema50
        ? 'ขาขึ้น'
        : i.ema8 < i.ema21 && i.ema21 < i.ema50
          ? 'ขาลง'
          : 'ไม่ชัดเจน';
  } else {
    $('trendValue').textContent = '--';
  }
}

function isFresh(data) {
  return Boolean(
    data &&
    data.ok === true &&
    data.dataFresh === true &&
    Number.isFinite(data.dataAgeSeconds) &&
    data.dataAgeSeconds >= 0 &&
    data.dataAgeSeconds <= MAX_DATA_AGE_SECONDS &&
    (data.signal === 'CALL' ||
      data.signal === 'PUT' ||
      data.signal === 'STANDBY')
  );
}

function renderMarket(data) {
  state.current = data;
  renderIndicators(data);

  if (!isFresh(data)) {
    setDataState(
      data.code || 'DATA_STALE',
      data.message || 'ข้อมูลไม่สด — งดสัญญาณ',
      false
    );
    return;
  }

  setDataState('OK', '', true);
}

async function refreshStatus() {
  try {
    const data = await getJSON('/api/status');
    state.lastStatus = data;

    $('quotaText').textContent =
      `${data.dailyCalls} / ${data.maxCallsPerDay}`;

    if (!data.apiConfigured) {
      setDataState('CONFIG_ERROR', 'ยังไม่ได้ตั้งค่า API Key บน Render', false);
    } else if (data.status === 'API_LIMIT') {
      setDataState('API_LIMIT', data.message, false);
    }
  } catch (error) {
    if (String(error.message).includes('Telegram')) {
      setDataState('AUTH_REQUIRED', error.message, false);
    } else {
      $('quotaText').textContent = '-- / --';
    }
  }
}

async function scanMarket() {
  if (!state.running || state.busy) return;

  state.busy = true;
  $('refreshButton').disabled = true;

  try {
    const symbol = $('pairSelect').value;
    const data = await getJSON(
      `/api/market?symbol=${encodeURIComponent(symbol)}`
    );

    renderMarket(data);
    await refreshStatus();
  } catch (error) {
    state.current = null;
    setDataState('DATA_STALE', error.message, false);
  } finally {
    state.busy = false;
    $('refreshButton').disabled = false;
  }
}

function prepareAudio() {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    throw new Error('เบราว์เซอร์ไม่รองรับเสียง');
  }

  if (!state.audioContext) {
    state.audioContext = new AudioContextClass();
  }

  return state.audioContext.resume();
}

function beep(frequency = 740, duration = 180) {
  if (!state.soundEnabled || !state.audioContext) return;

  try {
    const ctx = state.audioContext;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.setValueAtTime(
      0.12,
      ctx.currentTime + duration / 1000 * 0.65
    );
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + duration / 1000
    );

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + duration / 1000);
  } catch (error) {
    console.warn('เสียงแจ้งเตือนไม่พร้อม:', error);
  }
}

function entryVibration() {
  // Telegram's native haptic feedback, when supported.
  try {
    tg?.HapticFeedback?.impactOccurred('heavy');
    tg?.HapticFeedback?.notificationOccurred('warning');
  } catch {
    // Continue to browser fallback.
  }

  // Android WebView vibration fallback.
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate([180, 100, 250]);
    }
  } catch {
    // Some WebViews do not allow vibration.
  }
}

async function toggleSound() {
  if (state.soundEnabled) {
    state.soundEnabled = false;
    $('soundButton').textContent = 'เปิดเสียง';
    return;
  }

  try {
    await prepareAudio();
    state.soundEnabled = true;
    $('soundButton').textContent = 'ปิดเสียง';

    // Test beep confirms audio was unlocked by the user's tap.
    beep(740, 180);
    clearAlert();
  } catch (error) {
    alertBox('เปิดเสียงไม่สำเร็จ', error.message);
  }
}

function triggerEntrySignal(minuteKey) {
  if (state.lastEntryMinute === minuteKey) return;
  state.lastEntryMinute = minuteKey;

  const data = state.current;

  if (!isFresh(data)) {
    standby('ข้อมูลไม่สด — ยกเลิกสัญญาณรอบนี้');
    return;
  }

  if (
    data.signal !== 'CALL' &&
    data.signal !== 'PUT'
  ) {
    standby('คะแนนไม่ผ่านเกณฑ์ — ไม่มีสัญญาณเข้าออเดอร์');
    return;
  }

  if (!Number.isFinite(data.score) || data.score < 68) {
    standby('คะแนนต่ำกว่าเกณฑ์ — รอรอบใหม่');
    return;
  }

  // Avoid repeated signals from the same candle.
  const candleKey = `${data.symbol}:${data.candleTime}`;

  if (state.lastSignalCandle === candleKey) {
    standby('แท่งนี้แจ้งสัญญาณไปแล้ว — รอแท่งใหม่');
    return;
  }

  state.lastSignalCandle = candleKey;

  showSignal(data.signal, data.score, data.reason);

  // Entry alert: sound and vibration only when a valid signal is accepted.
  if (state.soundEnabled) {
    beep(data.signal === 'CALL' ? 880 : 440, 260);

    setTimeout(() => {
      if (state.soundEnabled) {
        beep(data.signal === 'CALL' ? 1040 : 350, 220);
      }
    }, 300);
  }

  entryVibration();
}

function tick() {
  const now = Date.now();
  const remainingMs = 60000 - (now % 60000);
  const seconds = Math.ceil(remainingMs / 1000);
  const minuteKey = Math.floor(now / 60000);

  $('countdown').textContent =
    `00:${String(seconds).padStart(2, '0')}`;

  // A signal is never allowed to remain on after its hold period.
  if (
    state.activeSignal !== 'STANDBY' &&
    now >= state.signalExpiresAt
  ) {
    standby('ครบ 40 วินาที — กลับ STANDBY');
  }

  if (!state.running || !isFresh(state.current)) return;

  // Warning in the last 10 seconds, even when there is no CALL/PUT.
  if (
    remainingMs <= WARNING_SECONDS * 1000 &&
    remainingMs > ENTRY_SECONDS * 1000 &&
    state.lastWarningMinute !== minuteKey
  ) {
    state.lastWarningMinute = minuteKey;

    if (state.soundEnabled) {
      beep(660, 220);
      setTimeout(() => beep(660, 220), 280);
    }
  }

  // At 5 seconds, show a signal only if the latest analysis passes.
  if (
    remainingMs <= ENTRY_SECONDS * 1000 &&
    remainingMs > 0 &&
    state.lastEntryMinute !== minuteKey
  ) {
    triggerEntrySignal(minuteKey);
  }
}

function toggleScanning() {
  state.running = !state.running;
  $('scanButton').textContent = state.running ? 'หยุดสแกน' : 'เริ่มสแกน';

  if (state.running) {
    scanMarket();
  } else {
    standby('หยุดสแกนตามคำสั่งผู้ใช้');
  }
}

$('soundButton').addEventListener('click', toggleSound);
$('scanButton').addEventListener('click', toggleScanning);
$('refreshButton').addEventListener('click', scanMarket);

$('pairSelect').addEventListener('change', () => {
  state.current = null;
  state.lastSignalCandle = null;
  state.lastEntryMinute = null;
  standby('กำลังโหลดข้อมูลคู่เงินใหม่');
  scanMarket();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.running) {
    scanMarket();
  }
});

(async function init() {
  try {
    const config = await getJSON('/api/config');

    if (Number.isFinite(config.signalHoldSeconds)) {
      // Server setting takes precedence when present.
      state.holdSeconds = Math.max(
        5,
        Math.min(120, config.signalHoldSeconds)
      );
    }
  } catch (error) {
    if (String(error.message).includes('Telegram')) {
      setDataState('AUTH_REQUIRED', error.message, false);
      $('scanButton').disabled = true;
      $('refreshButton').disabled = true;
      return;
    }
  }

  await refreshStatus();
  await scanMarket();

  // Client checks timing often; server-side cache prevents excessive API calls.
  setInterval(tick, 100);
  setInterval(scanMarket, 15000);
  setInterval(refreshStatus, 30000);
})();
