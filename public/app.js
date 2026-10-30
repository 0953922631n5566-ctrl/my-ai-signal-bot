"use strict";

const $ = id => document.getElementById(id);
function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
  else console.warn("ข้ามการอัปเดตข้อความ: ไม่พบ element #" + id);
}
const EMA_PERIODS = Array.from({ length: 20 }, (_, i) => i + 1);
const EMA_COLORS = ["#f6c453","#ff8c42","#e879f9","#48d1cc","#a3e635","#fb7185","#60a5fa","#facc15","#c084fc","#34d399","#f97316","#38bdf8","#e5e7eb","#a78bfa","#fda4af","#22d3ee","#fb923c","#a3e635","#f472b6","#818cf8"];

const state = {
  sound: false, vibrate: false, audioContext: null, loading: false,
  latestData: null, activeDirection: "STANDBY", activeUntil: 0,
  activeMessage: "", lastSignalMinute: null, lastTriggeredSignalIds: new Set(),
  warning10Minute: null, warning2Minute: null
};

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

function showNotice(title, message) {
  setText("noticeTitle", title);
  setText("noticeText", message);
  $("notice").classList.remove("hidden");
}
function hideNotice() { $("notice").classList.add("hidden"); }
function setConnection(online, text) {
  $("connectionDot").className = online ? "dot online" : "dot offline";
  setText("connectionText", text);
}
function formatNumber(value, digits = 5) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "--";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function formatTime(value) {
  if (!value) return "รอข้อมูล";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "รอข้อมูล";
  return date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
    gain.gain.setValueAtTime(0.15, ctx.currentTime + Math.max(0.025, duration - 0.03));
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
  } catch (error) { console.warn("เล่นเสียงไม่ได้:", error.message); }
}
function vibrate(pattern) {
  if (!state.vibrate || typeof navigator.vibrate !== "function") return;
  try { navigator.vibrate(pattern); } catch (error) { console.warn("อุปกรณ์ไม่รองรับการสั่น"); }
}
async function getJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "เซิร์ฟเวอร์ตอบกลับ " + response.status);
    return data;
  } finally { clearTimeout(timeout); }
}
async function postJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method:"POST", cache:"no-store", headers:{Accept:"application/json"}, signal:controller.signal });
    const data = await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error || "เซิร์ฟเวอร์ตอบกลับ "+response.status);
    return data;
  } finally { clearTimeout(timeout); }
}
function renderScanControls(data) {
  const active=Boolean(data && data.scanActive);
  $("startScanBtn").disabled=active;
  $("stopScanBtn").disabled=!active;
  setText("startScanBtn", active?"กำลังสแกนอยู่":"เปิดสแกน");
  setText("stopScanBtn", active?"ปิดสแกน":"สแกนปิดอยู่");
  setText("scanStateText", active
    ?"สถานะ: เปิดสแกน · ตรวจข้อมูลทุก 1 นาที"
    :"สถานะ: ปิดสแกน · "+((data&&data.scanStopReason)||"รอให้กดเปิดสแกน"));
  $("scanStateText").classList.toggle("scan-active",active);
}

function renderEmaGrid(data) {
  const values = data.emaValues || {};
  const active = new Map((data.emaSignals || []).map(signal => [signal.ema, signal.direction]));
  $("emaGrid").innerHTML = EMA_PERIODS.map((period, index) => {
    const direction = active.get(period);
    const status = direction || "READY";
    return '<div class="ema-tile" style="--ema-color:' + EMA_COLORS[index] + '">' +
      '<div class="ema-tile-top"><span>EMA ' + period + '</span><i class="ema-dot ' + (direction ? direction.toLowerCase() : "") + '"></i></div>' +
      '<strong>' + formatNumber(values[period], 5) + '</strong><small>' + status + '</small></div>';
  }).join("");

  setText("emaSignalCount", (data.emaSignals || []).length + " SIGNAL");
  const trend = data.marketTrend || "NEUTRAL";
  setText("trendLabel", "แนวโน้มหลัก: " + (trend === "UP" ? "ขาขึ้น" : trend === "DOWN" ? "ขาลง" : "เป็นกลาง"));
  $("trendLabel").className = "trend-label " + trend.toLowerCase();

  const signals = data.emaSignals || [];
  $("emaSignals").innerHTML = signals.length ? signals.map(signal =>
    '<div class="ema-signal-row ' + signal.direction.toLowerCase() + '">' +
    '<strong>EMA ' + signal.ema + '</strong><span>' + signal.direction + '</span>' +
    '<small>' + signal.reason + '</small><b>' + signal.score + '%</b></div>'
  ).join("") : '<p class="empty-state">ยังไม่มีแท่งปิดตัด EMA ตามแนวโน้มหลัก</p>';
}


function renderAIAnalysis(data) {
  const analysis = data.aiAnalysis || {};
  const summary = $("aiSummary"), metrics = $("aiMetrics");
  if (!summary || !metrics) return;
  const votes = Array.isArray(analysis.strategyVotes) ? analysis.strategyVotes : [];
  setText("aiModeBadge", "AI รวมหลายกลยุทธ์");
  summary.textContent = "CALL " + (analysis.callVotes || 0) + " กลุ่ม · PUT " +
    (analysis.putVotes || 0) + " กลุ่ม · ต้องเห็นตรงกันอย่างน้อย 4 กลุ่ม";
  metrics.innerHTML = votes.length ? votes.map(v =>
    '<div class="ema-signal-row ' + String(v.direction || "standby").toLowerCase() + '">' +
    '<strong>' + String(v.name || "Strategy") + '</strong><span>' +
    String(v.direction || "NO SIGNAL") + '</span><small>' +
    String(v.detail || "") + '</small><b>' + Number(v.weight || 0) + ' pts</b></div>'
  ).join("") : '<p class="empty-state">' +
    ((analysis.blockers || []).join(" · ") || "กำลังรวบรวมข้อมูลหลายกลยุทธ์") + '</p>';
}
function drawPriceChart(data) {
  const canvas = $("priceChart");
  const candles = data.candles || [];
  if (!canvas || candles.length < 2) return;
  const width = Math.max(300, canvas.getBoundingClientRect().width);
  const height = 260;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const prices = [];
  candles.forEach(c => {
    prices.push(c.high, c.low);
    EMA_PERIODS.forEach(period => {
      const value = c.emas && c.emas[period];
      if (Number.isFinite(value)) prices.push(value);
    });
  });
  let min = Math.min.apply(null, prices);
  let max = Math.max.apply(null, prices);
  const padding = (max - min) * 0.08 || Math.abs(max) * 0.0001 || 0.0001;
  min -= padding;
  max += padding;

  const left = 8, right = width - 8, top = 10, bottom = height - 18;
  const x = index => left + index * (right - left) / (candles.length - 1);
  const y = price => bottom - (price - min) * (bottom - top) / (max - min);

  ctx.strokeStyle = "rgba(140,160,190,.15)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const gy = top + i * (bottom - top) / 3;
    ctx.beginPath(); ctx.moveTo(left, gy); ctx.lineTo(right, gy); ctx.stroke();
  }

  const candleWidth = Math.max(2, Math.min(7, (right - left) / candles.length * 0.62));
  candles.forEach((c, index) => {
    const cx = x(index);
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? "#25d99a" : "#ff5d75";
    ctx.fillStyle = up ? "#25d99a" : "#ff5d75";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, y(c.high)); ctx.lineTo(cx, y(c.low)); ctx.stroke();
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyHeight = Math.max(1, Math.abs(y(c.open) - y(c.close)));
    ctx.fillRect(cx - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
  });

  EMA_PERIODS.forEach((period, index) => {
    ctx.beginPath();
    ctx.strokeStyle = EMA_COLORS[index];
    ctx.lineWidth = period >= 50 ? 1.8 : 1.25;
    let started = false;
    candles.forEach((c, candleIndex) => {
      const value = c.emas && c.emas[period];
      if (!Number.isFinite(value)) { started = false; return; }
      if (!started) { ctx.moveTo(x(candleIndex), y(value)); started = true; }
      else ctx.lineTo(x(candleIndex), y(value));
    });
    ctx.stroke();
  });
}
function renderChartLegend() {
  $("chartLegend").innerHTML = EMA_PERIODS.map((period, index) =>
    '<span><i style="background:' + EMA_COLORS[index] + '"></i>EMA ' + period + '</span>'
  ).join("");
}

function renderSignal(data) {
  const now = Date.now();
  let direction = "STANDBY";
  let message = data.reason || "กำลังรอข้อมูลรอบถัดไป";
  if (state.activeUntil > now && ["CALL", "PUT"].includes(state.activeDirection) && data.dataFresh === true && !data.error) {
    direction = state.activeDirection;
    message = state.activeMessage;
  } else {
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;
    if (data.error) message = data.error;
    else if (data.dataFresh !== true) message = "ข้อมูลเก่าหรือไม่พร้อม รอข้อมูลใหม่";
    else message = data.reason || "รอสัญญาณจาก EMA";
  }

  const card = $("signalCard");
  card.classList.remove("call", "put", "standby");
  card.classList.add(direction.toLowerCase());
  setText("signalTitle", direction);
  setText("signalArrow", direction === "CALL" ? "↑" : direction === "PUT" ? "↓" : "●");
  setText("signalMessage", message);
  const score = direction === "STANDBY" ? 0 : Math.max(0, Math.min(100, Number(data.score) || 0));
  setText("score", score + "%");
  $("scoreBar").style.width = score + "%";
  setText("price", formatNumber(data.price, 5));
  const rsiElement = $("rsi14");
  if (rsiElement) rsiElement.textContent = formatNumber(data.rsi14, 2);
  const macdElement = $("macd");
  if (macdElement) macdElement.textContent = formatNumber(data.macd, 6);
  setText("lastUpdated", formatTime(data.fetchedAt || data.lastPollAt));
  const pairHeading = document.querySelector(".market-heading h2");
  if (pairHeading && data.symbol) pairHeading.textContent = data.symbol;
  renderEmaGrid(data);
  renderAIAnalysis(data);
  drawPriceChart(data);
}

async function refreshDashboard() {
  if (state.loading) return;
  state.loading = true;
  $("refreshBtn").disabled = true;
  setText("refreshBtn", "กำลังตรวจสอบ…");
  try {
    const results = await Promise.all([getJson("/api/health"), getJson("/api/status")]);
    const health = results[0], data = results[1];
    const previousCandleTime = state.latestData && state.latestData.candleTime;
    state.latestData = data;
    renderScanControls(data);
    // Only alert after the server reports a different, fully closed candle.
    if (previousCandleTime && data.candleTime && data.candleTime !== previousCandleTime &&
        data.dataFresh === true && !data.error) {
      triggerSignalForClosedCandle(data);
    }
    const connected = health.apiKeyConfigured === true && data.dataFresh === true && !data.error && data.price !== null && data.price !== undefined;
    if (connected) { setConnection(true, "เชื่อมต่อข้อมูลตลาดแล้ว"); hideNotice(); }
    else {
      setConnection(false, "ข้อมูลตลาดมีปัญหา");
      showNotice("ตรวจพบปัญหาข้อมูลตลาด", health.error || data.error || "ข้อมูลยังไม่พร้อม รอข้อมูลใหม่");
    }
    renderSignal(data);
  } catch (error) {
    setConnection(false, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้");
    showNotice("การเชื่อมต่อขัดข้อง", error.name === "AbortError" ? "เซิร์ฟเวอร์ตอบช้าเกินกำหนด ลองใหม่อีกครั้ง" : error.message || "ตรวจสอบสถานะ Render");
    state.latestData = null;
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;
    renderSignal({ candidate: "STANDBY", dataFresh: false, score: 0, price: null, reason: "ไม่สามารถยืนยันข้อมูลตลาดได้", emaValues: {}, emaSignals: [], candles: [] });
  } finally {
    state.loading = false;
    $("refreshBtn").disabled = false;
    setText("refreshBtn", "สแกนข้อมูลอีกครั้ง");
  }
}

function minuteKey(date) {
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()].join("-");
}
function triggerSignalForClosedCandle(data) {
  if (!data || data.dataFresh !== true || data.error) return;
  const signal = data.aiSignal;
  if (!signal || !signal.id || !["CALL","PUT"].includes(signal.direction)) {
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;
    renderSignal(data);
    return;
  }
  if (state.lastTriggeredSignalIds.has(signal.id)) return;
  state.lastTriggeredSignalIds.add(signal.id);
  if (state.lastTriggeredSignalIds.size > 300) {
    state.lastTriggeredSignalIds = new Set(Array.from(state.lastTriggeredSignalIds).slice(-150));
  }
  state.activeDirection = signal.direction;
  state.activeUntil = Date.now() + Number(data.signalDurationMs || 40000);
  state.activeMessage = signal.reason || "AI Ensemble · " + signal.direction;
  renderSignal(Object.assign({}, data, {
    candidate: state.activeDirection,
    score: signal.score || data.score || 0,
    reason: state.activeMessage
  }));
  playBeep(signal.direction === "CALL" ? 1050 : 480, 360);
  vibrate([180, 70, 180]);
}
function updateCountdown() {
  const now = new Date();
  const elapsed = now.getSeconds() * 1000 + now.getMilliseconds();
  const remainingMs = 60000 - elapsed;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  setText("countdown", String(Math.floor(remainingSeconds / 60)).padStart(2, "0") + ":" + String(remainingSeconds % 60).padStart(2, "0"));
  setText("countdownMessage", "อ้างอิงนาฬิกาอุปกรณ์ ไม่ใช่เวลาหมดอายุที่ยืนยันจาก IQ Option");
  $("countdownCard").classList.toggle("warning", remainingSeconds <= 10);
  const key = minuteKey(now);
  if (remainingMs <= 10000 && remainingMs > 0 && state.warning10Minute !== key) {
    state.warning10Minute = key; playBeep(650, 220); vibrate([160]);
  }
  if (remainingMs <= 2000 && remainingMs > 0 && state.warning2Minute !== key) {
    state.warning2Minute = key; playBeep(900, 300); vibrate([120, 60, 120]);
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
    } catch (error) { console.warn("เปิดเสียงไม่ได้:", error.message); }
  }
  setText("soundBtn", state.sound ? "ปิดเสียง" : "เปิดเสียง");
  $("soundBtn").classList.toggle("active", state.sound);
});
$("vibrateBtn").addEventListener("click", () => {
  state.vibrate = !state.vibrate;
  setText("vibrateBtn", state.vibrate ? "ปิดสั่น" : "เปิดสั่น");
  $("vibrateBtn").classList.toggle("active", state.vibrate);
  if (state.vibrate) vibrate([100]);
});
$("startScanBtn").addEventListener("click", async () => {
  $("startScanBtn").disabled=true;
  setText("startScanBtn", "กำลังเปิดสแกน…");
  try {
    const data=await postJson("/api/scan/start",30000);
    state.latestData=data;
    renderScanControls(data);
    await refreshDashboard();
  } catch(error) {
    showNotice("เปิดสแกนไม่สำเร็จ",error.message||"ตรวจสอบการเชื่อมต่อ Render");
    $("startScanBtn").disabled=false;
    setText("startScanBtn", "เปิดสแกน");
  }
});
$("stopScanBtn").addEventListener("click", async () => {
  $("stopScanBtn").disabled=true;
  try {
    const data=await postJson("/api/scan/stop");
    state.latestData=data;
    renderScanControls(data);
    state.activeDirection="STANDBY";
    state.activeUntil=0;
    await refreshDashboard();
  } catch(error) {
    showNotice("ปิดสแกนไม่สำเร็จ",error.message||"ลองอีกครั้ง");
    $("stopScanBtn").disabled=false;
  }
});
$("refreshBtn").addEventListener("click", refreshDashboard);
let heartbeatBusy=false;
setInterval(async()=>{
  if(document.hidden || heartbeatBusy) return;
  heartbeatBusy=true;
  try {
    const data=await postJson("/api/scan/heartbeat",8000);
    renderScanControls(data);
  } catch(error) { console.warn("ส่ง heartbeat ไม่สำเร็จ:",error.message); }
  finally { heartbeatBusy=false; }
},20000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshDashboard();
    if(state.latestData && state.latestData.scanActive) postJson("/api/scan/heartbeat",8000).catch(()=>{});
  }
});
window.addEventListener("pagehide",()=>{ /* Server watchdog stops scanning if this page closes. */ });
window.addEventListener("resize", () => { if (state.latestData) drawPriceChart(state.latestData); });
renderChartLegend();
updateCountdown();
setInterval(updateCountdown, 200);
refreshDashboard();
setInterval(refreshDashboard, 5000);
