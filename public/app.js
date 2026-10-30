"use strict";

const $ = id => document.getElementById(id);
function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
  else console.warn("ข้ามการอัปเดตข้อความ: ไม่พบ element #" + id);
}
const EMA_PERIODS = [3, 5, 8, 9, 12, 15, 18, 21, 25, 30, 35, 40, 50, 75, 100];
const EMA_COLORS = ["#f6c453", "#ff8c42", "#e879f9", "#48d1cc", "#a3e635", "#fb7185", "#60a5fa", "#facc15", "#c084fc", "#34d399", "#f97316", "#38bdf8", "#e5e7eb", "#a78bfa", "#fda4af"];

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
  const analysis = data.aiAnalysis;
  const summary = $("aiSummary");
  const metrics = $("aiMetrics");
  if (!summary || !metrics) return;
  if (!analysis) { summary.textContent = "ยังไม่มีผลวิเคราะห์ AI"; metrics.innerHTML = ""; return; }
  setText("aiModeBadge", analysis.passed ? "FILTER PASSED" : "STRICT FILTER");
  summary.textContent = (analysis.passed ? "ผ่านตัวกรอง · " : "STANDBY · ") +
    (analysis.trend === "UP" ? "แนวโน้มขาขึ้น" : analysis.trend === "DOWN" ? "แนวโน้มขาลง" : "แนวโน้มเป็นกลาง") +
    " · คะแนนความสอดคล้อง " + analysis.score + "% · เห็นพ้อง " + analysis.alignedVotes + "/8";
  const tech = data.technicalIndicators || {};
  const fakeout = data.fakeout || analysis.fakeout || null;
  const fakeoutLabel = !fakeout || fakeout.status === "NO_FAKEOUT" ? "ไม่พบสัญญาณหลอก" :
    fakeout.confirmed ? "ยืนยันกลับทิศ " + fakeout.originalDirection + " → " + fakeout.reversalDirection :
    "เฝ้าระวัง Fakeout · ยังไม่กลับสัญญาณ";
  const fakeoutClass = fakeout && fakeout.confirmed ? fakeout.reversalDirection.toLowerCase() : fakeout && fakeout.detected ? "standby" : "call";
  const fakeoutEvidence = fakeout && Array.isArray(fakeout.evidence)
    ? fakeout.evidence.map(item => (item.passed ? "✓ " : "× ") + item.label).join(" · ")
    : "รอข้อมูลแท่งปิด";
  const reviewStats = data.signalReviewStats || {};
  const reviewRow = horizon => {
    const stat = reviewStats[horizon] || {};
    const original = stat.original || {}, final = stat.final || {};
    const fmt = item => item.winRate === null || item.winRate === undefined ? "--" :
      item.winRate + "% (" + item.wins + "/" + item.count + ")";
    return ["ผลย้อนหลัง " + horizon + " แท่ง", "เดิม " + fmt(original) + " · หลังปรับ " + fmt(final),
      "นับเฉพาะผลที่มีแท่งปิดครบแล้ว"];
  };
  const pressure = tech.pressure || analysis.pressure || null;
  const pressureLabel = pressure ? "ซื้อ " + pressure.buy + "% · ขาย " + pressure.sell + "%" : "--";
  const pressureStatus = !pressure ? "รอข้อมูล" : pressure.confirmed ? "ยืนยันฝั่ง " + (pressure.direction === "CALL" ? "ซื้อ" : "ขาย") : "แรงยังไม่พอ · STANDBY";
  const historyLabel = (data.historyBars || 0) + " / " + (data.historyBarsRequired || 500) + " แท่ง";
  const creditLabel = data.apiCreditsLeft === null || data.apiCreditsLeft === undefined ? "--" : data.apiCreditsLeft + " เครดิต";
  const rows = [
    ["ประวัติข้อมูลที่ใช้", historyLabel, "ใช้แท่งปิดย้อนหลังเพื่อให้ EMA100 มีช่วง warm-up มากขึ้น"],
    ["API credits เหลือต่อนาที", creditLabel, data.apiCreditsUsed === null || data.apiCreditsUsed === undefined ? "รอข้อมูลจาก response headers ของ Twelve Data" : "คำขอล่าสุดใช้ " + data.apiCreditsUsed + " เครดิต"],
    ["แรงซื้อ / แรงขาย", pressureLabel, pressureStatus + " · 3 แท่งล่าสุด ซื้อ " + (pressure ? pressure.recentBuy : "--") + "% / ขาย " + (pressure ? pressure.recentSell : "--") + "%"],
    ["Fakeout / กลับทิศ", fakeoutLabel, fakeoutEvidence],
    reviewRow(1), reviewRow(2), reviewRow(3),
    ["คะแนนยืนยันกลับทิศ", fakeout && fakeout.detected ? fakeout.score + "%" : "--", "ต้องผ่านอย่างน้อย 4 ใน 5 เงื่อนไข"],
    ["ADX", tech.adx14, "แรงของแนวโน้ม"], ["RSI", tech.rsi14, "โมเมนตัม"],
    ["MACD Histogram", tech.macdHistogram, "ทิศทางโมเมนตัม"],
    ["Stochastic K/D", tech.stochastic ? tech.stochastic.k + " / " + tech.stochastic.d : "--", "แรงซื้อขาย"],
    ["CCI", tech.cci20, "โมเมนตัมราคา"], ["Williams %R", tech.williamsR14, "ตำแหน่งในกรอบ"],
    ["ATR", tech.atr14, "ความผันผวน"], ["Bollinger width", tech.bollinger ? tech.bollinger.width + "%" : "--", "ความกว้างกรอบ"]
  ];
  const gates = analysis.gates || {};
  const gateLabels = {trendAligned:"ทิศทางตรงเทรนด์",adxStrongEnough:"ADX ≥ 18",confluence:"คะแนน/เสียงเห็นพ้อง",buyingSellingPressure:"แรงซื้อ/ขายยืนยัน 5 แท่ง",notOverextended:"ไม่ไล่ราคาห่าง EMA21",candleClosed:"ใช้แท่งปิดแล้ว"};
  const gateHtml = Object.keys(gateLabels).map(key =>
    '<div class="ema-signal-row ' + (gates[key] ? "call" : "standby") + '"><strong>' +
    (gates[key] ? "ผ่าน" : "ไม่ผ่าน") + '</strong><span>' + gateLabels[key] + '</span></div>'
  ).join("");
  const rowHtml = rows.map(row =>
    '<div class="ema-signal-row"><strong>' + row[0] + '</strong><span>' +
    (row[1] === null || row[1] === undefined ? "--" : row[1]) + '</span><small>' + row[2] + '</small></div>'
  ).join("");
  metrics.innerHTML = '<p class="eyebrow">ตัวกรองเข้มงวด</p>' + gateHtml +
    '<p class="eyebrow">ตรวจจับสัญญาณหลอก / กลับทิศ</p>' +
    '<div class="ema-signal-row ' + fakeoutClass + '"><strong>' + fakeoutLabel + '</strong><small>' +
    (fakeout ? fakeout.reason : "รอข้อมูล") + '</small><b>' +
    (fakeout && fakeout.detected ? fakeout.score + "%" : "--") + '</b></div>' +
    '<p class="empty-state">' + fakeoutEvidence + '</p>' +
    '<p class="eyebrow">เครื่องมือที่ AI ใช้</p>' + rowHtml +
    '<p class="empty-state">' + (analysis.blockers || []).join(" · ") + '</p>';
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
  const signal = data && data.aiSignal;
  if (!data || data.dataFresh !== true || data.error || !signal ||
      !signal.id || state.lastTriggeredSignalIds.has(signal.id)) {
    state.activeDirection = "STANDBY";
    state.activeUntil = 0;
    renderSignal(data || { dataFresh: false, reason: "รอแท่ง 1 นาทีปิด" });
    return;
  }
  state.lastTriggeredSignalIds.add(signal.id);
  state.activeDirection = signal.direction;
  state.activeUntil = Date.now() + Number(data.signalDurationMs || 40000);
  state.activeMessage = "ยืนยันหลังแท่งปิด · " + signal.reason;
  renderSignal(Object.assign({}, data, {
    candidate: signal.direction, score: signal.score, reason: state.activeMessage
  }));
  playBeep(signal.direction === "CALL" ? 1050 : 480, 320);
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
