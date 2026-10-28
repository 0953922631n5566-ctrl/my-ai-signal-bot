
(() => {
  const tg = window.Telegram?.WebApp;

  if (tg) {
    tg.ready();
    tg.expand();

    try {
      tg.setHeaderColor('#090d17');
      tg.setBackgroundColor('#090d17');
    } catch (_) {}
  }

  const $ = id => document.getElementById(id);

  const state = {
    symbol: 'EUR/USD',
    data: null,
    config: null,
    soundEnabled: false,
    lastBeepMinute: null,
    lastSignalKey: null,
    signalUntil: 0,
    displayedSignal: 'STANDBY',
    requestBusy: false,
    lastSuccess: 0,
    lastSignalRequest: 0
  };

  const initData = tg?.initData || '';
  const apiHeaders = {
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': initData
  };

  let audioContext = null;
  let toastTimer = null;

  function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function setConnection(status, message) {
    const el = $('connection');
    el.className = `connection ${status}`;
    el.querySelector('span').textContent = message;
  }

  function beep(frequency = 880, duration = 120) {
    if (!state.soundEnabled) return;

    try {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) return;

      if (!audioContext) audioContext = new AudioContextClass();

      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.12,
        audioContext.currentTime + 0.01
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        audioContext.currentTime + duration / 1000
      );

      oscillator.connect(gain);
      gain.connect(audioContext.destination);

      oscillator.start();
      oscillator.stop(
        audioContext.currentTime + duration / 1000 + 0.02
      );
    } catch (_) {
      // Some browsers block audio until the user interacts with the page.
    }
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return '—';
    if (value >= 100) return value.toFixed(3);
    if (value >= 10) return value.toFixed(4);
    return value.toFixed(5);
  }

  function formatCountdown(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return `00:${String(s).padStart(2, '0')}`;
  }

  function renderSignal(signal, subtitle) {
    const light = $('signalLight');

    light.className =
      'signal-light ' +
      (signal === 'CALL' ? 'call' :
       signal === 'PUT' ? 'put' :
       signal === 'PREPARE' ? 'prepare' : 'standby');

    $('signalWord').textContent =
      signal === 'PREPARE' ? 'เตรียมตัว' : signal;

    $('signalSub').textContent =
      subtitle || 'รอเงื่อนไขที่เหมาะสม';
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', {
        cache: 'no-store'
      });

      if (!response.ok) throw new Error('Config request failed');

      state.config = await response.json();
      $('sourceLabel').textContent = 'TWELVE DATA · M1';

      if (!state.config.symbols.includes(state.symbol)) {
        state.symbol = state.config.symbols[0];
        $('symbol').value = state.symbol;
      }
    } catch (_) {
      showToast('โหลดการตั้งค่าระบบไม่สำเร็จ');
    }
  }

  async function scan() {
    if (state.requestBusy) return;

    state.requestBusy = true;

    try {
      const url =
        `/api/market?symbol=${encodeURIComponent(state.symbol)}`;

      const response = await fetch(url, {
        headers: apiHeaders,
        cache: 'no-store'
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          setConnection('offline', 'เปิดผ่าน Telegram');
        } else {
          setConnection('offline', 'ข้อมูลขัดข้อง');
        }

        // Do not keep displaying an old CALL/PUT after a data error.
        state.data = null;
        state.displayedSignal = 'STANDBY';
        state.signalUntil = 0;

        renderSignal('STANDBY', data.error || 'ข้อมูลตลาดไม่พร้อม');
        showToast(data.error || 'ดึงข้อมูลตลาดไม่สำเร็จ');
        return;
      }

      state.data = data;
      state.lastSuccess = Date.now();

      setConnection('online', 'ระบบทำงานปกติ');
      render(data);
    } catch (_) {
      state.data = null;
      state.displayedSignal = 'STANDBY';
      state.signalUntil = 0;

      setConnection('offline', 'อินเทอร์เน็ตขาด');
      renderSignal('STANDBY', 'ขาดการเชื่อมต่อ — ไม่ใช้สัญญาณเก่า');
    } finally {
      state.requestBusy = false;
    }
  }

  function render(data) {
    $('price').textContent = formatPrice(data.price);
    $('score').textContent = `${data.score}/100`;

    const indicators = data.indicators;

    $('rsi').textContent =
      indicators.rsi == null ? '—' : indicators.rsi.toFixed(1);

    $('rsiState').textContent =
      indicators.rsi == null ? 'รอข้อมูล' :
      indicators.rsi >= 70 ? 'เขตซื้อมาก' :
      indicators.rsi <= 30 ? 'เขตขายมาก' : 'ระดับปกติ';

    $('macd').textContent =
      indicators.macdHistogram == null
        ? '—'
        : indicators.macdHistogram.toExponential(2);

    $('macdState').textContent =
      indicators.macdHistogram == null ? 'รอข้อมูล' :
      indicators.macdHistogram > 0 ? 'แรงส่งบวก' :
      indicators.macdHistogram < 0 ? 'แรงส่งลบ' : 'เป็นกลาง';

    const up =
      indicators.ema8 > indicators.ema21 &&
      indicators.ema21 > indicators.ema50;

    const down =
      indicators.ema8 < indicators.ema21 &&
      indicators.ema21 < indicators.ema50;

    $('trend').textContent =
      up ? 'ขาขึ้น' : down ? 'ขาลง' : 'ไม่ชัด';

    $('trendState').textContent =
      up || down ? 'EMA alignment' : 'EMA ผสมกัน';

    $('quota').textContent =
      `${data.quota.remainingSafetyCalls} / ` +
      `${data.quota.dailySafetyLimit} calls`;

    $('updatedAt').textContent =
      `อัปเดต ${new Date(data.lastFetchTime).toLocaleTimeString(
        'th-TH',
        { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      )}`;

    const list = $('reasonList');
    list.replaceChildren();

    (data.reasons || []).slice(0, 4).forEach(reason => {
      const item = document.createElement('div');
      item.className = 'reason-item';
      item.textContent = reason;
      list.appendChild(item);
    });

    if (!list.children.length) {
      const item = document.createElement('div');
      item.className = 'reason-item';
      item.textContent = 'ยังไม่มีเหตุผลวิเคราะห์';
      list.appendChild(item);
    }

    updateClock();
    updateSignal();
  }

  function secondsToNextMinute() {
    return 60 - (Math.floor(Date.now() / 1000) % 60);
  }

  function updateClock() {
    const seconds = secondsToNextMinute();

    $('countdown').textContent = formatCountdown(seconds);
    $('minuteProgress').style.width =
      `${((60 - seconds) / 60) * 100}%`;

    return seconds;
  }

  function updateSignal() {
    const data = state.data;
    if (!data) return;

    const seconds = updateClock();
    const currentMinute = Math.floor(Date.now() / 60000);

    // Prepare warning once per minute. The Mini App must be open
    // and sound must have been enabled by the user.
    if (
      seconds <= (state.config?.prepareBeepSeconds || 10) &&
      state.lastBeepMinute !== currentMinute
    ) {
      state.lastBeepMinute = currentMinute;
      beep(620, 130);
    }

    // Use only the latest server result. Do not imply that the
    // signal is a calibrated probability or a guaranteed entry.
    if (
      seconds <= (state.config?.entrySignalSeconds || 2) &&
      state.displayedSignal === 'STANDBY' &&
      state.lastSignalRequest !== currentMinute
    ) {
      state.lastSignalRequest = currentMinute;

      const candidate = data.signal;
      const signalKey =
        `${state.symbol}:${data.candleTimestamp}:${candidate}`;

      if (
        candidate !== 'STANDBY' &&
        state.lastSignalKey !== signalKey
      ) {
        state.lastSignalKey = signalKey;
        state.displayedSignal = candidate;
        state.signalUntil =
          Date.now() + (state.config?.holdSeconds || 40) * 1000;

        renderSignal(
          candidate,
          `คะแนน ${data.score}/100 · ตรวจสอบราคากับโบรกเกอร์ก่อนตัดสินใจ`
        );

        beep(candidate === 'CALL' ? 1040 : 440, 230);
      }
    }

    if (Date.now() >= state.signalUntil &&
        state.displayedSignal !== 'STANDBY') {
      state.displayedSignal = 'STANDBY';
      renderSignal('STANDBY', 'รีเซ็ตสัญญาณแล้ว — รอรอบถัดไป');
    } else if (state.displayedSignal === 'STANDBY') {
      renderSignal('STANDBY', data.note);
    }
  }

  $('symbol').value = state.symbol;

  $('symbol').addEventListener('change', event => {
    state.symbol = event.target.value;
    state.data = null;
    state.displayedSignal = 'STANDBY';
    state.signalUntil = 0;
    state.lastSignalKey = null;
    state.lastSignalRequest = 0;
    state.lastBeepMinute = null;

    renderSignal('STANDBY', 'กำลังโหลดข้อมูลคู่เงินใหม่');
    scan();
  });

  $('scanBtn').addEventListener('click', scan);

  $('soundBtn').addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;

    $('soundBtn').textContent =
      state.soundEnabled ? 'ปิดเสียงเตือน' : 'เปิดเสียงเตือน';

    if (state.soundEnabled) {
      beep(880, 100);
      showToast('เปิดเสียงแล้ว — ต้องเปิด Mini App ค้างไว้');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scan();
  });

  window.addEventListener('online', () => {
    if (!state.data) scan();
  });

  window.addEventListener('offline', () => {
    setConnection('offline', 'อินเทอร์เน็ตขาด');
    renderSignal('STANDBY', 'ขาดการเชื่อมต่อ — ไม่ใช้สัญญาณเก่า');
  });

  (async () => {
    await loadConfig();
    await scan();

    // This polling rate uses fewer API requests than a 1-second loop.
    // Check your Twelve Data plan before increasing the frequency.
    setInterval(scan, 30000);
    setInterval(() => {
      if (state.data) updateSignal();

      if (state.lastSuccess &&
          Date.now() - state.lastSuccess > 45000) {
        setConnection('offline', 'ข้อมูลไม่อัปเดต');
      }
    }, 250);
  })();
})();
