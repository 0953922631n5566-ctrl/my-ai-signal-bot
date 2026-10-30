"use strict";

const express = require("express");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.FOREX_PAIR || "EUR/USD";
const POLL_MS = Math.max(60000, Number(process.env.POLL_INTERVAL_MS) || 60000);

const MAX_DATA_AGE_MS = 90000;
const HISTORY_BARS = 200;
const MIN_COMPLETED_BARS = 60;
const SIGNAL_DURATION_MS = 40000;
const EMA_PERIODS = Array.from({ length: 20 }, (_, i) => i + 1);

const state = {
  source: "Twelve Data", symbol: SYMBOL, interval: "1min",
  price: null, candleTime: null, fetchedAt: null, fetchedAtMs: 0,
  emaValues: {}, emaSignals: [], marketTrend: "NEUTRAL",
  rsi14: null, macd: null, bullVotes: 0, bearVotes: 0,
  score: 0, candidate: "STANDBY", reason: "กำลังรอข้อมูลตลาด",
  aiSignal: null, aiAnalysis: null, technicalIndicators: {},
  error: null, candles: [], historyBars: 0, apiCreditsUsed: null, apiCreditsLeft: null, signalReviews: [], lastPollAt: null, nextPollAt: null
};

let pollInProgress = false;
let pollTimer = null;
let scanActive = false;
let lastClientHeartbeatMs = 0;
let scanStopReason = "ยังไม่ได้เปิดสแกน";
let heartbeatWatchdog = null;

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const out = Array(period - 1).fill(null);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(current);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    out.push(current);
  }
  return out;
}
function sma(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(0, d); loss += Math.max(0, -d);
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  if (al === 0) return 100;
  if (ag === 0) return 0;
  return 100 - 100 / (1 + ag / al);
}
function macdData(values) {
  const fast = emaSeries(values, 12), slow = emaSeries(values, 26);
  const line = values.map((_, i) => Number.isFinite(fast[i]) && Number.isFinite(slow[i]) ? fast[i] - slow[i] : null);
  const valid = line.filter(Number.isFinite);
  const signalValid = emaSeries(valid, 9);
  const signal = Array(line.length).fill(null);
  let j = 0;
  for (let i = 0; i < line.length; i++) if (Number.isFinite(line[i])) signal[i] = signalValid[j++];
  const last = line.length - 1;
  return {
    line: line[last], signal: signal[last],
    histogram: Number.isFinite(line[last]) && Number.isFinite(signal[last]) ? line[last] - signal[last] : null
  };
}
function atrSeries(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  if (tr.length < period) return [];
  const out = Array(period - 1).fill(null);
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(value);
  for (let i = period; i < tr.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out.push(value);
  }
  return out;
}
function adxValue(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trs = [], plus = [], minus = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const up = cur.high - prev.high, down = prev.low - cur.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  let tr = trs.slice(0, period).reduce((a,b)=>a+b,0);
  let p = plus.slice(0, period).reduce((a,b)=>a+b,0);
  let m = minus.slice(0, period).reduce((a,b)=>a+b,0);
  const dx = [];
  for (let i = period; i < trs.length; i++) {
    if (i > period) { tr = tr - tr / period + trs[i]; p = p - p / period + plus[i]; m = m - m / period + minus[i]; }
    const pdi = tr ? 100 * p / tr : 0, mdi = tr ? 100 * m / tr : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  if (dx.length < period) return null;
  let value = dx.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < dx.length; i++) value = (value * (period - 1) + dx[i]) / period;
  return value;
}
function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const window = values.slice(-period), mid = sma(values, period);
  const variance = window.reduce((sum, v) => sum + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + mult * sd, middle: mid, lower: mid - mult * sd, width: mid ? (4 * sd / mid) * 100 : null };
}
function stochastic(candles, period = 14, smooth = 3) {
  if (candles.length < period + smooth) return null;
  const kValues = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map(c => c.high)), low = Math.min(...window.map(c => c.low));
    kValues.push(high === low ? 50 : 100 * (candles[i].close - low) / (high - low));
  }
  const k = kValues[kValues.length - 1], d = sma(kValues, smooth);
  const prevD = kValues.length > smooth ? kValues.slice(-smooth - 1, -1).reduce((a,b)=>a+b,0) / smooth : d;
  const prevK = kValues[kValues.length - 2];
  return { k, d, crossedUp: prevK <= prevD && k > d, crossedDown: prevK >= prevD && k < d };
}
function cci(candles, period = 20) {
  if (candles.length < period) return null;
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  const mean = sma(tp, period), window = tp.slice(-period);
  const deviation = window.reduce((s,v)=>s+Math.abs(v-mean),0) / period;
  return deviation ? (tp[tp.length - 1] - mean) / (0.015 * deviation) : 0;
}
function williamsR(candles, period = 14) {
  if (candles.length < period) return null;
  const w = candles.slice(-period), high = Math.max(...w.map(c=>c.high)), low = Math.min(...w.map(c=>c.low));
  return high === low ? -50 : -100 * (high - w[w.length - 1].close) / (high - low);
}
function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function calculatePressure(candles, lookback = 5) {
  const recent = candles.slice(-lookback);
  if (recent.length < lookback) return {buy:50,sell:50,delta:0,recentBuy:50,recentSell:50,confirmed:false,direction:"NEUTRAL",samples:recent.length,reason:"รอแท่งปิดให้ครบ 5 แท่ง"};
  const values = recent.map(c => {
    const range = Math.max(c.high-c.low, Number.EPSILON);
    const closeLocation = ((c.close-c.low)/range)*2-1;
    const body = (c.close-c.open)/range;
    return Math.max(0,Math.min(100,50+closeLocation*30+body*20));
  });
  const weighted = values.reduce((sum,v,i)=>sum+v*(i+1),0);
  const buy = weighted/15, recentBuy = values.slice(-3).reduce((sum,v)=>sum+v,0)/3;
  const sell=100-buy, recentSell=100-recentBuy, delta=buy-sell;
  const direction=buy>sell?"CALL":sell>buy?"PUT":"NEUTRAL";
  const confirmed=(buy>=58&&delta>=16&&recentBuy>=52)||(sell>=58&&delta<=-16&&recentSell>=52);
  return {buy:round(buy,1),sell:round(sell,1),delta:round(delta,1),recentBuy:round(recentBuy,1),recentSell:round(recentSell,1),confirmed,direction,samples:5,
    reason:confirmed?"แรงฝั่ง"+(direction==="CALL"?"ซื้อ":"ขาย")+"เด่นทั้ง 5 แท่งและ 3 แท่งล่าสุด":"แรงซื้อขายยังไม่ยืนยันหรือแรงช่วงล่าสุดไม่ต่อเนื่อง"};
}

function detectFakeout(candles, ema21, indicators, baseDirection) {
  const empty = { status:"NO_FAKEOUT", detected:false, confirmed:false, originalDirection:baseDirection,
    reversalDirection:null, score:0, evidence:[], reason:"ไม่พบรูปแบบหลอกที่ยืนยันได้" };
  if (!baseDirection || !["CALL","PUT"].includes(baseDirection) || candles.length < 15) return empty;
  const current = candles[candles.length - 1], previous = candles[candles.length - 2];
  const range = candles.slice(-13, -1);
  const swingHigh = Math.max(...range.map(c => c.high));
  const swingLow = Math.min(...range.map(c => c.low));
  const span = Math.max(current.high - current.low, Number.EPSILON);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const upperReject = current.high > swingHigh && current.close < swingHigh && upperWick / span >= 0.35;
  const lowerReject = current.low < swingLow && current.close > swingLow && lowerWick / span >= 0.35;
  const reversalDirection = upperReject ? "PUT" : lowerReject ? "CALL" : null;
  if (!reversalDirection || reversalDirection === baseDirection) return empty;
  const bearish = current.close < current.open;
  const bullish = current.close > current.open;
  const oppositeBody = reversalDirection === "PUT" ? bearish : bullish;
  const emaConfirm = reversalDirection === "PUT" ? current.close < ema21 : current.close > ema21;
  const macdConfirm = reversalDirection === "PUT" ? indicators.macdHistogram < 0 : indicators.macdHistogram > 0;
  const rsiConfirm = reversalDirection === "PUT" ? indicators.rsi14 <= 47 : indicators.rsi14 >= 53;
  const followThrough = reversalDirection === "PUT" ? current.close < previous.close : current.close > previous.close;
  const checks = [
    { key:"แท่งปิดสวนทาง", passed:oppositeBody },
    { key:"ราคาปิดข้าม EMA21", passed:emaConfirm },
    { key:"MACD สนับสนุน", passed:macdConfirm },
    { key:"RSI สนับสนุน", passed:rsiConfirm },
    { key:"แรงต่อเนื่องจากแท่งก่อน", passed:followThrough }
  ];
  const passed = checks.filter(x => x.passed).length;
  const confirmed = oppositeBody && passed >= 4;
  return {
    status:confirmed ? "REVERSAL_CONFIRMED" : "FAKEOUT_WATCH",
    detected:true, confirmed, originalDirection:baseDirection, reversalDirection,
    score:Math.round(passed / checks.length * 100),
    evidence:checks.map(x => ({label:x.key, passed:x.passed})),
    reason:confirmed
      ? "พบการปฏิเสธราคาที่กรอบล่าสุดและมีหลักฐานกลับทิศ " + passed + "/5 ข้อ"
      : "พบไส้เทียนปฏิเสธราคา แต่หลักฐานกลับทิศยังไม่ครบ (" + passed + "/5)"
  };
}

function analyzeMarket(candles) {
  const closes = candles.map(c => c.close);
  const last = closes.length - 1, prev = last - 1;
  const price = closes[last], candle = candles[last];
  const ema = {}, emaLines = {};
  for (const period of EMA_PERIODS) {
    emaLines[period] = emaSeries(closes, period);
    ema[period] = emaLines[period][last];
  }
  const ema50Line = emaSeries(closes, 50);
  const ema100Line = emaSeries(closes, 100);
  const ema50 = ema50Line[last], ema100 = ema100Line[last];
  const rsi14 = rsi(closes, 14);
  const macd = macdData(closes);
  const atrValues = atrSeries(candles, 14);
  const atr14 = atrValues.length ? atrValues[atrValues.length - 1] : null;
  const adx14 = adxValue(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const stoch = stochastic(candles, 14, 3);
  const cci20 = cci(candles, 20);
  const willR14 = williamsR(candles, 14);
  const pressure = calculatePressure(candles, 5);

  // Directional movement (DMI) is calculated from the same Twelve Data OHLC candles.
  let plusDI = null, minusDI = null;
  if (candles.length >= 15) {
    const tr = [], plus = [], minus = [];
    for (let i = 1; i < candles.length; i++) {
      const cur = candles[i], before = candles[i - 1];
      const up = cur.high - before.high, down = before.low - cur.low;
      tr.push(Math.max(cur.high-cur.low, Math.abs(cur.high-before.close), Math.abs(cur.low-before.close)));
      plus.push(up > down && up > 0 ? up : 0);
      minus.push(down > up && down > 0 ? down : 0);
    }
    const p = tr.slice(-14).reduce((a,v)=>a+v,0);
    const up = plus.slice(-14).reduce((a,v)=>a+v,0);
    const down = minus.slice(-14).reduce((a,v)=>a+v,0);
    if (p > 0) { plusDI = 100*up/p; minusDI = 100*down/p; }
  }

  const votes = [];
  const addVote = (name, direction, weight, detail) => {
    if (direction === "CALL" || direction === "PUT") votes.push({name,direction,weight,detail});
  };
  const emaTrendUp = ema[5] > ema[9] && ema[9] > ema[20] && ema[20] > emaLines[20][prev];
  const emaTrendDown = ema[5] < ema[9] && ema[9] < ema[20] && ema[20] < emaLines[20][prev];
  addVote("EMA trend", emaTrendUp ? "CALL" : emaTrendDown ? "PUT" : null, 25,
    "EMA5/9/20 alignment and EMA20 slope");

  const macdUp = Number.isFinite(macd.histogram) && macd.histogram > 0 && macd.line > macd.signal;
  const macdDown = Number.isFinite(macd.histogram) && macd.histogram < 0 && macd.line < macd.signal;
  addVote("MACD momentum", macdUp ? "CALL" : macdDown ? "PUT" : null, 15,
    "MACD line, signal line and histogram");

  let oscillatorDirection = null;
  const rsiUp = Number.isFinite(rsi14) && rsi14 >= 55 && rsi14 < 78;
  const rsiDown = Number.isFinite(rsi14) && rsi14 <= 45 && rsi14 > 22;
  const stochUp = stoch && stoch.k > stoch.d && stoch.k >= 50;
  const stochDown = stoch && stoch.k < stoch.d && stoch.k <= 50;
  const cciUp = Number.isFinite(cci20) && cci20 > 25;
  const cciDown = Number.isFinite(cci20) && cci20 < -25;
  const willUp = Number.isFinite(willR14) && willR14 > -50;
  const willDown = Number.isFinite(willR14) && willR14 < -50;
  const oscBull = [rsiUp,stochUp,cciUp,willUp].filter(Boolean).length;
  const oscBear = [rsiDown,stochDown,cciDown,willDown].filter(Boolean).length;
  if (oscBull >= 3 && oscBull > oscBear) oscillatorDirection = "CALL";
  else if (oscBear >= 3 && oscBear > oscBull) oscillatorDirection = "PUT";
  addVote("RSI / Stochastic / CCI / Williams %R", oscillatorDirection, 15,
    "Multi-oscillator consensus");

  let strengthDirection = null;
  if (Number.isFinite(adx14) && adx14 >= 18 && Number.isFinite(plusDI) && Number.isFinite(minusDI)) {
    if (plusDI > minusDI * 1.12) strengthDirection = "CALL";
    else if (minusDI > plusDI * 1.12) strengthDirection = "PUT";
  }
  addVote("ADX / DMI strength", strengthDirection, 15, "ADX and directional movement");

  const current = candles[last], previous = candles[prev];
  const priorRange = candles.slice(-21, -1);
  const priorHigh = Math.max(...priorRange.map(c=>c.high));
  const priorLow = Math.min(...priorRange.map(c=>c.low));
  const body = current.close - current.open;
  const range = Math.max(current.high-current.low, Number.EPSILON);
  const upperWick = current.high-Math.max(current.open,current.close);
  const lowerWick = Math.min(current.open,current.close)-current.low;
  const bullishEngulf = current.close > current.open && previous.close < previous.open &&
    current.open <= previous.close && current.close >= previous.open;
  const bearishEngulf = current.close < current.open && previous.close > previous.open &&
    current.open >= previous.close && current.close <= previous.open;
  const bullishBreak = current.close > priorHigh && body > 0;
  const bearishBreak = current.close < priorLow && body < 0;
  const bullishReject = current.low < priorLow && current.close > priorLow && lowerWick/range >= 0.35;
  const bearishReject = current.high > priorHigh && current.close < priorHigh && upperWick/range >= 0.35;
  let priceActionDirection = null;
  if (bullishBreak || bullishEngulf || bullishReject || (pressure.confirmed && pressure.direction === "CALL")) {
    priceActionDirection = "CALL";
  } else if (bearishBreak || bearishEngulf || bearishReject || (pressure.confirmed && pressure.direction === "PUT")) {
    priceActionDirection = "PUT";
  }
  addVote("Price action / breakout / rejection", priceActionDirection, 20,
    "Candle structure, swing breakout, rejection and buying pressure");

  let volatilityDirection = null;
  if (bb && Number.isFinite(bb.upper) && Number.isFinite(bb.lower)) {
    const width = bb.width;
    if (Number.isFinite(width) && width > 0) {
      if (adx14 >= 20 && price > bb.upper && body > 0) volatilityDirection = "CALL";
      else if (adx14 >= 20 && price < bb.lower && body < 0) volatilityDirection = "PUT";
      else if (adx14 < 20 && price < bb.lower && rsi14 < 35 && body > 0) volatilityDirection = "CALL";
      else if (adx14 < 20 && price > bb.upper && rsi14 > 65 && body < 0) volatilityDirection = "PUT";
    }
  }
  addVote("Bollinger / volatility regime", volatilityDirection, 10,
    "Bollinger breakout in trend or mean-reversion in range");

  const callWeight = votes.filter(v=>v.direction==="CALL").reduce((s,v)=>s+v.weight,0);
  const putWeight = votes.filter(v=>v.direction==="PUT").reduce((s,v)=>s+v.weight,0);
  const activeWeight = callWeight + putWeight;
  const callVotes = votes.filter(v=>v.direction==="CALL").length;
  const putVotes = votes.filter(v=>v.direction==="PUT").length;
  const winningDirection = callWeight > putWeight ? "CALL" : putWeight > callWeight ? "PUT" : "STANDBY";
  const winningWeight = Math.max(callWeight,putWeight);
  const score = activeWeight ? Math.round(winningWeight/activeWeight*100) : 0;
  const oppositeWeight = winningDirection === "CALL" ? putWeight : callWeight;
  const alignedVotes = winningDirection === "CALL" ? callVotes : putVotes;
  const hasTrendOrPriceAction = votes.some(v =>
    v.direction === winningDirection && (v.name === "EMA trend" || v.name === "Price action / breakout / rejection"));
  const strongOpposition = oppositeWeight >= 20;
  const enoughConsensus = alignedVotes >= 4 && score >= 72 && hasTrendOrPriceAction && !strongOpposition;
  const direction = enoughConsensus ? winningDirection : "STANDBY";

  // Retain per-EMA crossover diagnostics for the dashboard; they no longer fire separate trade alerts.
  const emaSignals = [];
  for (const period of EMA_PERIODS) {
    const currentEma = emaLines[period][last], previousEma = emaLines[period][prev];
    let signalDirection = null;
    if (period === 1) {
      const priorSlope = emaLines[1][prev] - emaLines[1][prev-1];
      const currentSlope = currentEma - previousEma;
      if (priorSlope <= 0 && currentSlope > 0) signalDirection = "CALL";
      else if (priorSlope >= 0 && currentSlope < 0) signalDirection = "PUT";
    } else if (closes[prev] <= previousEma && price > currentEma && currentEma > previousEma) signalDirection = "CALL";
    else if (closes[prev] >= previousEma && price < currentEma && currentEma < previousEma) signalDirection = "PUT";
    if (signalDirection) emaSignals.push({
      id:String(candle.datetime)+":EMA"+period+":"+signalDirection,
      ema:period,direction:signalDirection,score:100,candleTime:candle.datetime,
      reason:"EMA "+period+" crossover diagnostic"
    });
  }

  const emaValues = {};
  for (const period of EMA_PERIODS) emaValues[period] = round(ema[period]);
  const chartStart = Math.max(0,candles.length-80);
  const chartCandles = candles.slice(chartStart).map((c,offset)=>{
    const i=chartStart+offset,emas={};
    for(const period of EMA_PERIODS) emas[period]=round(emaLines[period][i]);
    return {...c,emas};
  });
  const trend = ema[20] > emaLines[20][prev] ? "UP" : ema[20] < emaLines[20][prev] ? "DOWN" : "NEUTRAL";
  const fakeout = direction === "STANDBY" ? null : detectFakeout(candles,ema[20],{
    macdHistogram:macd.histogram,rsi14
  },direction);
  const finalDirection = fakeout && fakeout.confirmed ? fakeout.reversalDirection : direction;
  const finalScore = fakeout && fakeout.confirmed ? Math.min(score,80) : score;
  const signal = finalDirection === "STANDBY" ? null : {
    id:String(candle.datetime)+":ENSEMBLE:"+finalDirection,
    direction:finalDirection,score:finalScore,alignedVotes,
    directionalVotes:votes.length,candleTime:candle.datetime,
    reason:"AI รวม "+alignedVotes+"/"+votes.length+" กลยุทธ์เห็นตรงกัน · "+finalDirection+
      (fakeout && fakeout.confirmed ? " · ตรวจพบสัญญาณกลับตัว" : "")
  };
  const indicators = {
    rsi14:round(rsi14,2),
    macdLine:round(macd.line,8),macdSignal:round(macd.signal,8),
    macdHistogram:round(macd.histogram,8),atr14:round(atr14,8),
    adx14:round(adx14,2),plusDI:round(plusDI,2),minusDI:round(minusDI,2),
    bollinger:bb?{upper:round(bb.upper),middle:round(bb.middle),lower:round(bb.lower),width:round(bb.width,3)}:null,
    stochastic:stoch?{k:round(stoch.k,2),d:round(stoch.d,2)}:null,
    cci20:round(cci20,2),williamsR14:round(willR14,2),
    pressure,ema50:round(ema50),ema100:round(ema100),
    strategyVotes:votes.map(v=>({name:v.name,direction:v.direction,weight:v.weight,detail:v.detail})),
    callWeight,putWeight,activeWeight
  };
  const analysis = {
    engine:"MULTI_STRATEGY_CONFLUENCE_V1",
    dataSource:"Twelve Data 1-minute OHLC",
    calculationSource:"คำนวณอินดิเคเตอร์และกลยุทธ์ทั้งหมดภายในระบบจาก OHLC",
    mode:"AI Ensemble · EMA 1–20 + RSI + MACD + Stochastic + CCI + Williams %R + ADX/DMI + ATR + Bollinger + Price Action",
    filter:"CONFLUENCE",
    trend,score:finalScore,direction:finalDirection,passed:Boolean(signal),
    callVotes,putVotes,callWeight,putWeight,alignedVotes,
    totalStrategies:votes.length,requiredVotes:4,minimumScore:72,
    blockers:signal?[]:[
      alignedVotes<4?"กลยุทธ์สนับสนุนทิศทางเดียวกันยังไม่ถึง 4 กลุ่ม":null,
      score<72?"คะแนนความสอดคล้องต่ำกว่า 72%":null,
      !hasTrendOrPriceAction?"ยังไม่มี Trend หรือ Price Action ยืนยัน":null,
      strongOpposition?"พบแรงขัดแย้งจากกลยุทธ์ฝั่งตรงข้าม":null,
      winningDirection==="STANDBY"?"กลยุทธ์ยังไม่เห็นทิศทางร่วมกัน":null
    ].filter(Boolean),
    strategyVotes:indicators.strategyVotes
  };
  return {price,candle,emaValues,emaSignals,chartCandles,trend,indicators,analysis,signal,fakeout,score:finalScore,closes};
}
function updateSignalReviews(candles, signal) {
  const reviews = state.signalReviews || [];
  for (const review of reviews) {
    const entryIndex = candles.findIndex(c => c.datetime === review.candleTime);
    if (entryIndex < 0) continue;
    for (const horizon of [1, 2, 3]) {
      if (review.originalOutcomes[horizon] !== null) continue;
      const target = candles[entryIndex + horizon];
      if (!target) continue;
      const outcome = (direction, entry, close) => {
        if (Math.abs(close - entry) < Number.EPSILON) return "FLAT";
        return direction === "CALL" ? (close > entry ? "WIN" : "LOSS") :
          (close < entry ? "WIN" : "LOSS");
      };
      review.originalOutcomes[horizon] = outcome(review.originalDirection, review.entryPrice, target.close);
      review.finalOutcomes[horizon] = outcome(review.finalDirection, review.entryPrice, target.close);
      review.reviewedThrough = target.datetime;
    }
  }
  if (signal && signal.id && !reviews.some(r => r.id === signal.id)) {
    reviews.push({
      id:signal.id, candleTime:signal.candleTime, entryPrice:candles[candles.length - 1].close,
      originalDirection:signal.originalDirection || signal.direction,
      finalDirection:signal.direction, wasReversed:Boolean(signal.originalDirection),
      originalOutcomes:{1:null,2:null,3:null}, finalOutcomes:{1:null,2:null,3:null},
      reviewedThrough:null
    });
  }
  return reviews.slice(-100);
}
function getSignalReviewStats(reviews) {
  const stats = {};
  for (const horizon of [1, 2, 3]) {
    const summarize = key => {
      const values = reviews.map(r => r[key][horizon]).filter(v => v === "WIN" || v === "LOSS");
      const wins = values.filter(v => v === "WIN").length;
      return { wins, losses:values.length-wins, count:values.length,
        winRate:values.length ? Math.round(wins / values.length * 100) : null };
    };
    stats[horizon] = { original:summarize("originalOutcomes"), final:summarize("finalOutcomes") };
  }
  return stats;
}

async function fetchMarketData() {
  if (!API_KEY) throw new Error("ยังไม่ได้ตั้ง TWELVE_DATA_API_KEY ใน Render Environment Variables");
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", String(HISTORY_BARS));
  url.searchParams.set("order", "desc");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);
  const response = await fetch(url, { signal:AbortSignal.timeout(15000), headers:{Accept:"application/json"} });
  if (!response.ok) throw new Error("Twelve Data HTTP " + response.status);
  const apiCreditsUsed = response.headers.get("api-credits-used");
  const apiCreditsLeft = response.headers.get("api-credits-left");
  const json = await response.json();
  if (json.status === "error" || json.code || !Array.isArray(json.values)) throw new Error(json.message || "Twelve Data ไม่ส่งข้อมูลแท่งเทียน");

  const now = Date.now();
  const completed = json.values.slice().reverse().filter(c => {
    const opened = Date.parse(String(c.datetime || "").replace(" ","T") + "Z");
    return Number.isFinite(opened) && opened + 60000 <= now;
  });
  if (completed.length < MIN_COMPLETED_BARS) throw new Error("ข้อมูลแท่งเทียนปิดแล้วมีเพียง " + completed.length + " แท่ง ต้องมีอย่างน้อย " + MIN_COMPLETED_BARS + " แท่งเพื่อให้ EMA 1–20 มีช่วง warm-up เพียงพอ");
  const candles = completed.map(c=>({datetime:c.datetime||null,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}));
  if (candles.some(c=>[c.open,c.high,c.low,c.close].some(v=>!Number.isFinite(v)||v<=0)||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close))) {
    throw new Error("ข้อมูล OHLC ที่ได้รับไม่ถูกต้อง");
  }
  const result = analyzeMarket(candles);
  state.signalReviews = updateSignalReviews(candles, result.signal);
  const stamp = Date.now();
  const bullVotes = Object.values(result.emaValues).filter(v=>result.price>v).length;
  const bearVotes = Object.values(result.emaValues).filter(v=>result.price<v).length;
  Object.assign(state,{
    price:round(result.price), candleTime:result.candle.datetime,
    historyBars:candles.length, apiCreditsUsed, apiCreditsLeft,
    fetchedAt:new Date(stamp).toISOString(), fetchedAtMs:stamp,
    emaValues:result.emaValues, emaSignals:result.emaSignals, marketTrend:result.trend,
    rsi14:result.indicators.rsi14, macd:result.indicators.macdHistogram,
    technicalIndicators:result.indicators, aiAnalysis:result.analysis, aiSignal:result.signal, fakeout:result.fakeout,
    bullVotes,bearVotes,score:result.signal?result.signal.score:0,
    candidate:result.signal?result.signal.direction:"STANDBY",
    reason:result.signal?result.signal.reason:"STANDBY · "+result.analysis.blockers.join(" / "),
    candles:result.chartCandles,error:null,lastPollAt:new Date(stamp).toISOString(),
    nextPollAt:new Date(stamp+POLL_MS).toISOString()
  });
  console.log("[AI SCAN] "+SYMBOL+" price="+state.price+" trend="+state.marketTrend+
    " score="+result.analysis.score+" EMA_CALL="+result.analysis.callSignals+
    " EMA_PUT="+result.analysis.putSignals+" signal="+state.candidate);
}

async function pollMarket() {
  if (pollInProgress) return false;
  pollInProgress = true;
  try { await fetchMarketData(); return true; }
  catch(error) {
    state.error=error.message||"ดึงข้อมูลตลาดไม่สำเร็จ";
    state.candidate="STANDBY"; state.score=0; state.emaSignals=[]; state.aiSignal=null;
    state.reason="ข้อมูลไม่พร้อม จึงไม่สร้างสัญญาณ";
    state.nextPollAt=new Date(Date.now()+POLL_MS).toISOString();
    console.error("[MARKET ERROR]",state.error); return false;
  } finally { pollInProgress=false; }
}
function publicState() {
  const age=state.fetchedAtMs?Date.now()-state.fetchedAtMs:Infinity;
  const fresh=age<=MAX_DATA_AGE_MS&&!state.error;
  return {
    source:state.source,calculationSource:"Twelve Data OHLC close prices",emaPeriods:EMA_PERIODS,symbol:state.symbol,interval:state.interval,price:state.price,
    candleTime:state.candleTime,fetchedAt:state.fetchedAt,dataAgeMs:Number.isFinite(age)?age:null,dataFresh:fresh,
    emaValues:state.emaValues,emaSignals:fresh?state.emaSignals:[],
    marketTrend:fresh?state.marketTrend:"NEUTRAL",candles:fresh?state.candles:[],
    rsi14:state.rsi14,macd:state.macd,bullVotes:state.bullVotes,bearVotes:state.bearVotes,
    technicalIndicators:fresh?state.technicalIndicators:{},aiAnalysis:fresh?state.aiAnalysis:null,fakeout:fresh?state.fakeout:null,
    aiSignal:fresh?state.aiSignal:null,score:fresh?state.score:0,
    candidate:fresh?state.candidate:"STANDBY",reason:fresh?state.reason:"ข้อมูลตลาดเก่าหรือยังไม่พร้อม",
    error:state.error,historyBars:state.historyBars,historyBarsRequired:MIN_COMPLETED_BARS,
    apiCreditsUsed:state.apiCreditsUsed,apiCreditsLeft:state.apiCreditsLeft,
    lastPollAt:state.lastPollAt,nextPollAt:scanActive?state.nextPollAt:null,
    scanActive, lastClientHeartbeatAt:lastClientHeartbeatMs?new Date(lastClientHeartbeatMs).toISOString():null,
    scanStopReason,
    signalReviews:state.signalReviews.slice(-10),signalReviewStats:getSignalReviewStats(state.signalReviews),
    serverTime:Date.now(),signalDurationMs:SIGNAL_DURATION_MS,minScore:0
  };
}
app.get("/api/health",(req,res)=>{
  const d=publicState(); res.set("Cache-Control","no-store");
  res.json({ok:Boolean(API_KEY)&&d.dataFresh,apiKeyConfigured:Boolean(API_KEY),dataFresh:d.dataFresh,
    source:d.source,symbol:d.symbol,serverTime:Date.now(),error:d.error||(!API_KEY?"ยังไม่ได้ตั้ง API Key":null)});
});
app.get("/api/status",(req,res)=>{res.set("Cache-Control","no-store");res.json(publicState());});
app.get("/api/radar",(req,res)=>{
  const d=publicState();res.set("Cache-Control","no-store");
  res.json({source:d.source,dataFresh:d.dataFresh,marketTrend:d.marketTrend,
    pairs:[{symbol:d.symbol,price:d.price,candidate:d.candidate,score:d.score,rsi14:d.rsi14,
      reason:d.reason,emaSignals:d.emaSignals,aiSignal:d.aiSignal,aiAnalysis:d.aiAnalysis,fakeout:d.fakeout}]});
});
function sendScanState(res) {
  const d=publicState(); res.set("Cache-Control","no-store");
  res.status(d.error&&!d.fetchedAt?503:200).json({ok:!d.error&&d.dataFresh,...d});
}
app.post("/api/scan/start",async(req,res)=>{
  res.set("Cache-Control","no-store");
  scanActive=true; lastClientHeartbeatMs=Date.now(); scanStopReason=null;
  if(heartbeatWatchdog) clearInterval(heartbeatWatchdog);
  heartbeatWatchdog=setInterval(()=>{
    if(scanActive && Date.now()-lastClientHeartbeatMs>65000) stopScanSession("หยุดสแกนอัตโนมัติ: ไม่พบการใช้งาน Mini App เกิน 65 วินาที");
  },10000);
  if(pollTimer) { clearTimeout(pollTimer); pollTimer=null; }
  await pollMarket();
  if(scanActive) scheduleNextPoll();
  sendScanState(res);
});
app.post("/api/scan/stop",(req,res)=>{ stopScanSession("ปิดสแกนโดยผู้ใช้"); sendScanState(res); });
app.post("/api/scan/heartbeat",(req,res)=>{ if(scanActive) lastClientHeartbeatMs=Date.now(); sendScanState(res); });
app.get("/api/scan",(req,res)=>sendScanState(res));
app.post("/api/scan",(req,res)=>sendScanState(res));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
function stopScanSession(reason) {
  scanActive=false; scanStopReason=reason||"ปิดสแกนแล้ว"; state.nextPollAt=null;
  if(pollTimer) { clearTimeout(pollTimer); pollTimer=null; }
  if(heartbeatWatchdog) { clearInterval(heartbeatWatchdog); heartbeatWatchdog=null; }
  console.log("[SCAN SESSION] stopped: "+scanStopReason);
}
function scheduleNextPoll() {
  if(!scanActive) return;
  // Align one fetch to just after each UTC minute boundary so the newly closed
  // one-minute candle is evaluated once it becomes available from the provider.
  const delay = Math.max(1000, 60000 - (Date.now() % 60000) + 1500);
  state.nextPollAt = new Date(Date.now() + delay).toISOString();
  pollTimer = setTimeout(async () => {
    pollTimer=null;
    if(!scanActive) return;
    await pollMarket();
    if(scanActive) scheduleNextPoll();
  }, delay);
}
app.listen(PORT,()=>{console.log("AI Signal Radar running on port "+PORT+" (idle until Mini App starts scanning)");});
process.on("SIGTERM",()=>{if(pollTimer)clearTimeout(pollTimer);if(heartbeatWatchdog)clearInterval(heartbeatWatchdog);process.exit(0);});