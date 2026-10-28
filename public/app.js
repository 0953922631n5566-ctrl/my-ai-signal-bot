(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    config: null,
    pair: 'EUR/USD',
    currentData: null,
    soundEnabled: false,
    autoScan: true,
    audio: null,
    alertedSignalIds: new Set(),
    activeSignalUntil: 0,
    warningMinuteKey: null,
    scanBusy: false
  };

  const telegramApp = window.Telegram?.WebApp;

  if (telegramApp) {
    try {
      telegramApp.ready();
      telegramApp.expand();
    } catch (_) {}
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.classList.remove('show');
    }, 2800);
  }

  function fmtPrice(value) {
    if (value === null || value === undefined ||
        !Number.isFinite(Number(value))) return '—';

    const n = Number(value);
    return n >= 100 ? n.toFixed(3) :
      n >= 1 ? n.toFixed(5) : n.toFixed(6);
  }

  function fmtNumber(value, digits = 2) {
    if (value === null || value === undefined ||
        !Number.isFinite(Number(value))) return '—';

    return Number(value).toFixed(digits);
  }

  function fmtTime(value) {
    if (!value) return '—';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    return date.toLocaleTimeString('th-TH', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function setConnection(message, connected = false) {
    $('connectionState').textContent = message;
    $('connectionState').style.color = connected
      ? 'var(--green)'
      : 'var(--muted)';
  }

  async function api(url, options = {}) {
    const response = await fetch(url, options);

    let data;
    try {
      data = await response.json();
    } catch (_) {
      throw new Error(`อ่านข้อมูลเซิร์ฟเวอร์ไม่ได้ (${response.status})`);
    }

    if (!response.ok && !data.error) {
      throw new Error(`เซิร์ฟเวอร์ตอบกลับ HTTP ${response.status}`);
    }

    return data;
  }

  function beep(frequency = 880, duration = 180, volume = 0.07) {
    if (!state.soundEnabled) return;
    if (document.visibilityState !== 'visible') return;

    try {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) return;

      if (!state.audio) {
        state.audio = new AudioContextClass();
      }

      if (state.audio.state === 'suspended') {
        state.audio.resume();
      }

      const oscillator = state.audio.createOscillator();
      const gain = state.audio.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.value = volume;

      oscillator.connect(gain);
      gain.connect(state.audio.destination);

      oscillator.start();

      gain.gain.setTargetAtTime(
        0.0001,
        state.audio.currentTime + duration / 1000 * 0.65,
        0.04
      );

      oscillator.stop(
        state.audio.currentTime + duration / 1000
      );
    } catch (error) {
      console.warn('Audio unavailable:', error);
    }
  }

  function vibrate(pattern = [180, 80, 180]) {
    try {
      if ('vibrate' in navigator) {
        navigator.vibrate(pattern);
      }
    } catch (_) {}
  }

  function updateCountdown() {
    const now = Date.now();
    const secondsIntoMinute = Math.floor((now % 60000) / 1000);
    const remaining = 60 - secondsIntoMinute;

    $('countdown').textContent =
      `${String(remaining).padStart(2, '0')}s`;

    $('countdownBar').style.width =
      `${((60 - remaining) / 60) * 100}%`;

    const minuteKey = Math.floor(now / 60000);

    if (
      remaining <= 10 &&
      state.warningMinuteKey !== minuteKey &&
      document.visibilityState === 'visible'
    ) {
      state.warningMinuteKey = minuteKey;

      if (state.soundEnabled) {
        beep(660, 140);
        setTimeout(() => beep(660, 140), 200);
      }
    }

    if (
      state.activeSignalUntil &&
      now >= state.activeSignalUntil
    ) {
      state.activeSignalUntil = 0;

      if (state.currentData) {
        renderMarket({
          ...state.currentData,
          signal: 'STANDBY',
          signalId: null
        });
      }
    }
  }

  function renderMarket(data) {
    state.currentData = data;

    const maxAge = state.config?.maxDataAgeSeconds || 180;

    const stale =
      data.stale === true ||
      data.ok === false ||
      (
        data.dataAgeSeconds !== null &&
        data.dataAgeSeconds !== undefined &&
        Number(data.dataAgeSeconds) > maxAge
      );

    let signal = stale ? 'STANDBY' : (data.signal || 'STANDBY');

    if (
      state.activeSignalUntil &&
      Date.now() >= state.activeSignalUntil
    ) {
      signal = 'STANDBY';
    }

    $('activePairLabel').textContent = data.pair || state.pair;
    $('priceValue').textContent = fmtPrice(data.price);
    $('scoreValue').textContent = `${Number(data.score || 0)}/100`;

    $('rsiValue').textContent = fmtNumber(data.rsi);

    $('rsiState').textContent = data.rsi == null
      ? 'รอข้อมูล'
      : Number(data.rsi) >= 70
        ? 'เขตซื้อมาก'
        : Number(data.rsi) <= 30
          ? 'เขตขายมาก'
          : 'ช่วงกลาง';

    $('trendValue').textContent = data.trend || '—';
    $('macdValue').textContent = fmtNumber(
      data.indicators?.macd, 6
    );

    $('ageValue').textContent =
      data.dataAgeSeconds == null
        ? '—'
        : `${data.dataAgeSeconds}s`;

    $('sourceValue').textContent = data.source || 'Twelve Data';
    $('reasonText').textContent =
      data.reason || data.error || 'ยังไม่มีข้อมูลวิเคราะห์';

    const light = $('signalLight');

    light.classList.remove('call', 'put', 'standby');
    light.classList.add(signal.toLowerCase());

    $('signalLabel').textContent = signal;

    $('signalSub').textContent = stale
      ? 'ข้อมูลเก่าหรือ API มีปัญหา — พักสัญญาณไว้ก่อน'
      : signal === 'CALL'
        ? 'เงื่อนไขทางเทคนิคเอนเอียงขึ้น'
        : signal === 'PUT'
          ? 'เงื่อนไขทางเทคนิคเอนเอียงลง'
          : 'ยังไม่มีสัญญาณที่ผ่านเกณฑ์';

    if (stale) {
      setConnection('ข้อมูลไม่สด', false);

      $('statusMessage').textContent =
        data.error ||
        'ข้อมูลไม่สด ระบบพักสัญญาณไว้ก่อนเพื่อความปลอดภัย';
    } else {
      setConnection('เชื่อมต่อแล้ว', true);

      $('statusMessage').textContent =
        `แท่งที่ใช้วิเคราะห์: ${fmtTime(data.latestCandleTime)} · ` +
        `${data.source || 'Twelve Data'} · ${data.timeframe || '1min'}`;
    }
  }

  function processSignal(data) {
    if (!data || data.stale || data.ok === false) return;

    if (!['CALL', 'PUT'].includes(data.signal)) return;
    if (!data.signalId) return;

    if (state.alertedSignalIds.has(data.signalId)) return;

    state.alertedSignalIds.add(data.signalId);

    if (state.alertedSignalIds.size > 300) {
      const oldest = state.alertedSignalIds.values().next().value;
      state.alertedSignalIds.delete(oldest);
    }

    state.activeSignalUntil = Date.now() +
      Number(data.holdSeconds || state.config?.holdSeconds || 40) * 1000;

    if (data.signal === 'CALL') {
      beep(1040, 260, 0.1);
      setTimeout(() => beep(1320, 200, 0.08), 280);
      vibrate([200, 80, 200, 80, 300]);
    } else {
      beep(520, 260, 0.1);
      setTimeout(() => beep(420, 200, 0.08), 280);
      vibrate([350, 100, 350]);
    }

    toast(
      `สัญญาณ ${data.signal} · ${data.pair} · คะแนน ${data.score}/100`
    );
  }

  async function scanMarket() {
    if (state.scanBusy) return;

    state.scanBusy = true;
    $('scanButton').disabled = true;

    try {
      const url = `/api/status?pair=${encodeURIComponent(state.pair)}`;
      const data = await api(url);

      renderMarket(data);
      processSignal(data);
    } catch (error) {
      setConnection('เชื่อมต่อไม่ได้', false);

      $('statusMessage').textContent = error.message;
      $('signalLight').className = 'signal-light standby';
      $('signalLabel').textContent = 'STANDBY';
      $('signalSub').textContent = 'ไม่พบข้อมูลยืนยัน';
    } finally {
      state.scanBusy = false;
      $('scanButton').disabled = false;
    }
  }

  async function loadConfig() {
    const config = await api('/api/config');
    state.config = config;

    if (Array.isArray(config.pairs) && config.pairs.length) {
      const select = $('pairSelect');
      select.innerHTML = '';

      config.pairs.forEach(pair => {
        const option = document.createElement('option');
        option.value = pair;
        option.textContent = pair;
        select.appendChild(option);
      });

      if (config.pairs.includes(state.pair)) {
        select.value = state.pair;
      } else {
        state.pair = config.pairs[0];
        select.value = state.pair;
      }
    }
  }

  async function scanRadar() {
    try {
      const data = await api('/api/scan');
      const results = data.results || [];
      const list = $('radarList');

      list.innerHTML = '';

      if (!results.length) {
        list.textContent = 'ยังไม่มีข้อมูลคู่เงิน';
        return;
      }

      results.forEach(item => {
        const row = document.createElement('div');
        row.className = 'radar-row' +
          (item.pair === state.pair ? ' selected' : '');

        const pair = document.createElement('span');
        pair.className = 'radar-pair';
        pair.textContent = item.pair || '—';

        const price = document.createElement('span');
        price.className = 'radar-price';
        price.textContent = fmtPrice(item.price);

        const signal = document.createElement('span');
        const signalText = item.stale
          ? 'STANDBY'
          : (item.signal || 'STANDBY');

        signal.className = `radar-signal ${signalText.toLowerCase()}`;
        signal.textContent = signalText;

        row.append(pair, price, signal);

        row.addEventListener('click', () => {
          state.pair = item.pair;
          $('pairSelect').value = item.pair;
          state.activeSignalUntil = 0;

          scanMarket();

          list.querySelectorAll('.radar-row').forEach(el => {
            el.classList.remove('selected');
          });

          row.classList.add('selected');
        });

        list.appendChild(row);
      });
    } catch (error) {
      $('radarList').textContent =
        `เรดาร์โหลดไม่ได้: ${error.message}`;
    }
  }

  async function initialise() {
    try {
      const health = await api('/api/health');

      if (!health.apiKeyConfigured) {
        setConnection('ยังไม่มี API Key', false);

        $('statusMessage').textContent =
          'เพิ่ม TWELVE_DATA_API_KEY ใน Render Environment แล้ว Deploy ใหม่';
      }

      await loadConfig();
      await scanMarket();
      await scanRadar();
    } catch (error) {
      setConnection('ตั้งค่าระบบไม่ครบ', false);
      $('statusMessage').textContent = error.message;
    }

    // เลี่ยงการเรียก API ถี่เกินไปในแพ็กเกจฟรี
    setInterval(() => {
      if (
        state.autoScan &&
        document.visibilityState === 'visible'
      ) {
        scanMarket();
      }
    }, 15000);

    // เรดาร์ทุก 60 วินาที เพื่อลดการใช้โควตา
    setInterval(() => {
      if (
        state.autoScan &&
        document.visibilityState === 'visible'
      ) {
        scanRadar();
      }
    }, 60000);

    setInterval(updateCountdown, 250);
    updateCountdown();
  }

  $('pairSelect').addEventListener('change', event => {
    state.pair = event.target.value;
    state.activeSignalUntil = 0;
    scanMarket();
  });

  $('scanButton').addEventListener('click', () => {
    scanMarket();
  });

  $('refreshAllButton').addEventListener('click', () => {
    scanMarket();
    scanRadar();
  });

  $('soundButton').addEventListener('click', async () => {
    state.soundEnabled = !state.soundEnabled;

    if (state.soundEnabled) {
      try {
        const AudioContextClass =
          window.AudioContext || window.webkitAudioContext;

        if (AudioContextClass) {
          if (!state.audio) {
            state.audio = new AudioContextClass();
          }

          await state.audio.resume();
        }

        $('soundButton').textContent = 'เสียง: เปิด';
        $('soundButton').classList.add('active');

        beep(880, 120);
        toast('เปิดเสียงแล้ว');
      } catch (_) {
        state.soundEnabled = false;
        toast('อุปกรณ์ไม่อนุญาตให้เปิดเสียง');
      }
    } else {
      $('soundButton').textContent = 'เปิดเสียง';
      $('soundButton').classList.remove('active');
      toast('ปิดเสียงแล้ว');
    }
  });

  $('vibrateButton').addEventListener('click', () => {
    if ('vibrate' in navigator) {
      vibrate([150, 80, 150]);
      toast('ส่งคำสั่งทดสอบสั่นแล้ว');
    } else {
      toast('เบราว์เซอร์หรืออุปกรณ์นี้ไม่รองรับการสั่น');
    }
  });

  $('autoButton').addEventListener('click', () => {
    state.autoScan = !state.autoScan;

    $('autoButton').textContent =
      `สแกนอัตโนมัติ: ${state.autoScan ? 'เปิด' : 'ปิด'}`;

    $('autoButton').classList.toggle('active', state.autoScan);

    toast(
      state.autoScan
        ? 'เปิดสแกนอัตโนมัติแล้ว'
        : 'ปิดสแกนอัตโนมัติแล้ว'
    );
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scanMarket();
      scanRadar();
    }
  });

  initialise();
})();