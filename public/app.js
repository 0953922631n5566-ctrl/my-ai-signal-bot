
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
  timer: null,
  statusTimer: null,
  current: null,
  activeSignal: 'STANDBY',
  signalExpiresAt: 0,
  lastSignalKey: '',
  lastBeeps: new Set(),
  audioContext: null,
  lastApiStatus: null
};

function telegramHeaders() {
  const headers = {};

  if (tg?.initData) {
    headers['x-telegram-init-data'] = tg.initData;
  }

  return headers;
}

async function getJSON(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: telegramHeaders(),
    cache: 'no-store'
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (${response.status})`);
  }

  if (response.status === 401 || data.code === 'AUTH_REQUIRED') {
    throw new Error('กรุณาเปิด Mini App จากปุ่มใน Telegram');
  }

  if (!response.ok) {
    throw new Error(data.message || `HTTP ${response.status}`);
  }

  return data;
}

function formatPrice(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '--';
  }

  const number = Number(value);
  return number >= 100
    ? number.toFixed(3)
    : number.toFixed(5);
}

function formatTime(value) {
  if (!value) return '--';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return '--';

  return date.toLocaleString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function showAlert(title, message) {
  $('alertBox').classList.remove('hidden');
  $('alertTitle').textContent = title;
  $('alertMessage').textContent = message;
}

function hideAlert() {
  $('alertBox').classList.add('hidden');
}

function setConnection(good, text) {
  $('connectionDot').className = `dot ${good ? 'good' : 'bad'}`;
  $('connectionText').textContent = text;
}

function setStandby(reason) {
  state.activeSignal = 'STANDBY';
  state.signalExpiresAt = 0;

  $('signalCard').className = 'signal-card standby';
  $('signalText').textContent = 'STANDBY';
  $('signalArrow').textContent = '●';
  $('signalScore').textContent = 'Score --';
  $('signalReason').textContent =
    reason || 'รอสัญญาณที่ผ่านการตรวจสอบ';
}

function setDataStatus(code, message, fresh) {
  const statusText = {
    OK: 'LIVE DATA',
    API_LIMIT: 'API LIMIT',
    DATA_STALE: 'DATA STALE',
    WAITING: 'WAITING',
    CONFIG_ERROR: 'CONFIG ERROR',
    AUTH_REQUIRED: 'AUTH REQUIRED'
  };

  $('dataStatus').textContent = statusText[code] || code || 'UNKNOWN';
  setConnection(Boolean(fresh), fresh ? 'ข้อมูลพร้อม' : 'ข้อมูลไม่พร้อม');

  if (!fresh) {
    setStandby(message || 'ข้อมูลไม่สด — หยุดสัญญาณ');
    if (message) showAlert($('dataStatus').textContent, message);
  } else {
    hideAlert();
  }
}

function renderMarket(data) {
  state.current = data;

  $('priceValue').textContent = formatPrice(data.price);
  $('candleTime').textContent = formatTime(data.candleTime);
  $('dataAge').textContent =
    Number.isFinite(data.dataAgeSeconds)
      ? `${data.dataAgeSeconds} วินาที`
      : '--';

  $('updatedAt').textContent =
    `รับข้อมูลล่าสุด ${formatTime(data.fetchedAt)}`;

  const indicators = data.indicators || {};

  $('rsiValue').textContent =
    Number.isFinite(indicators.rsi)
      ? Number(indicators.rsi).toFixed(1)
      : '--';

  $('macdValue').textContent =
    Number.isFinite(indicators.macd)
      ? Number(indicators.macd).toPrecision(4)
      : '--';

  if (
    Number.isFinite(indicators.ema8) &&
    Number.isFinite(indicators.ema21) &&
    Number.isFinite(indicators.ema50)
  ) {
    const trend =
      indicators.ema8 > indicators.ema21 &&
      indicators.ema21 > indicators.ema50
        ? 'ขาขึ้น'
        : indicators.ema8 < indicators.ema21 &&
          indicators.ema21 < indicators.ema50
          ? 'ขาลง'
          : 'ไม่ชัดเจน';

    $('trendValue').textContent = trend;
  } else {
    $('trendValue').textContent = '--';
  }

  if (!data.ok || data.dataFresh !== true) {
    setDataStatus(data.code || 'DATA_STALE', data.message, false);
    return;
  }

  setDataStatus('OK', '', true);

  const key = `${data.symbol}:${data.candleTime}`;

  // Only accept a signal once for each newly observed closed candle.
  if (key !== state.lastSignalKey) {
    state.lastSignalKey = key;

    if (
      (data.signal === 'CALL' || data.signal === 'PUT') &&
      Number(data.score) >= 1
    ) {
      state.activeSignal = data.signal;
      state.signalExpiresAt =
        Date.now() + Number(window.signalHoldSeconds || 40) * 1000;

      renderSignal(data.signal, data.score, data.reason);
    } else {
      setStandby(data.reason || 'คะแนนไม่ถึงเกณฑ์');
    }
  } else if (Date.now() >= state.signalExpiresAt) {
    setStandby('ครบเวลาสัญญาณแล้ว — รอรอบใหม่');
  }
}

function renderSignal(signal, score, reason) {
  const isCall = signal === 'CALL';
  $('signalCard').className = `signal-card ${isCall ? 'call' : 'put'}`;
  $('signalText').textContent = signal;
  $('signalArrow').textContent = isCall ? '↑' : '↓';
  $('signalScore').textContent = `Score ${score}`;
  $('signalReason').textContent = reason || 'ผ่านเกณฑ์วิเคราะห์';
}

async function refreshStatus() {
  try {
    const data = await getJSON('/api/status');
    state.lastApiStatus = data;

    $('quotaText').textContent =
      `${data.dailyCalls} / ${data.maxCallsPerDay}`;

    if (!data.apiConfigured) {
      setDataStatus('CONFIG_ERROR', data.message, false);
      return;
    }

    if (data.status === 'API_LIMIT') {
      setDataStatus('API_LIMIT', data.message, false);
    }
  } catch (error) {
    if (String(error.message).includes('Mini App')) {
      setDataStatus('AUTH_REQUIRED', error.message, false);
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
    setDataStatus('DATA STALE', error.message, false);
  } finally {
    state.busy = false;
    $('refreshButton').disabled = false;
  }
}

function getSecondsToMinuteBoundary() {
  const now = Date.now();
  const elapsed = now % 60000;
  return Math.ceil((60000 - elapsed) / 1000);
}

function updateCountdown() {
  const seconds = getSecondsToMinuteBoundary();
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  $('countdown').textContent = `${mm}:${ss}`;

  if (Date.now() >= state.signalExpiresAt) {
    if (state.activeSignal !== 'STANDBY') {
      setStandby('ครบเวลาสัญญาณแล้ว — รอรอบใหม่');
    }
  }

  const current = state.current;
  const fresh = current?.ok === true && current?.dataFresh === true;
  const active =
    state.activeSignal === 'CALL' || state.activeSignal === 'PUT';

  if (!state.soundEnabled || !fresh || !active) return;

  const minuteKey = Math.floor(Date.now() / 60000);
  const key10 = `${minuteKey}:10`;
  const key2 = `${minuteKey}:2`;

  if (seconds === 10 && !state.lastBeeps.has(key10)) {
    state.lastBeeps.add(key10);
    beep(660, 160);
  }

  if (seconds === 2 && !state.lastBeeps.has(key2)) {
    state.lastBeeps.add(key2);
    beep(880, 220);
  }

  if (state.lastBeeps.size > 20) {
    state.lastBeeps.clear();
  }
}

async function enableSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    if (!AudioCtx) {
      showAlert('เสียงไม่พร้อม', 'เบราว์เซอร์นี้ไม่รองรับเสียงแจ้งเตือน');
      return;
    }

    if (!state.audioContext) {
      state.audioContext = new AudioCtx();
    }

    await state.audioContext.resume();
    state.soundEnabled = true;
    $('soundButton').textContent = 'ปิดเสียง';
    beep(740, 120);
    hideAlert();
  } catch {
    showAlert('เสียงไม่พร้อม', 'แตะเปิดเสียงอีกครั้ง');
  }
}

function beep(frequency, duration) {
  if (!state.soundEnabled || !state.audioContext) return;

  try {
    const oscillator = state.audioContext.createOscillator();
    const gain = state.audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.value = 0.06;

    oscillator.connect(gain);
    gain.connect(state.audioContext.destination);

    oscillator.start();
    oscillator.stop(state.audioContext.currentTime + duration / 1000);
  } catch {
    // Sound failure must not affect market-data safety.
  }
}

function toggleScanning() {
  state.running = !state.running;

  $('scanButton').textContent = state.running
    ? 'หยุดสแกน'
    : 'เริ่มสแกน';

  if (state.running) {
    scanMarket();
  } else {
    setStandby('หยุดสแกนตามคำสั่งผู้ใช้');
  }
}

$('refreshButton').addEventListener('click', scanMarket);
$('scanButton').addEventListener('click', toggleScanning);

$('pairSelect').addEventListener('change', () => {
  state.lastSignalKey = '';
  state.current = null;
  setStandby('กำลังโหลดข้อมูลคู่เงินที่เลือก');
  scanMarket();
});

$('soundButton').addEventListener('click', async () => {
  if (state.soundEnabled) {
    state.soundEnabled = false;
    $('soundButton').textContent = 'เปิดเสียง';
  } else {
    await enableSound();
  }
});

(async function init() {
  try {
    const config = await getJSON('/api/config');
    window.signalHoldSeconds = config.signalHoldSeconds || 40;
  } catch (error) {
    if (String(error.message).includes('Mini App')) {
      setDataStatus('AUTH_REQUIRED', error.message, false);
      $('scanButton').disabled = true;
      $('refreshButton').disabled = true;
      return;
    }
  }

  await refreshStatus();
  await scanMarket();

  state.timer = setInterval(() => {
    updateCountdown();
    scanMarket();
  }, 15000);

  state.statusTimer = setInterval(refreshStatus, 30000);
  setInterval(updateCountdown, 250);
})();
