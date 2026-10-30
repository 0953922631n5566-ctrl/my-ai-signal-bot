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
const HISTORY_BARS = 300;
const MIN_COMPLETED_BARS = 220;
const SIGNAL_DURATION_MS = 40000;
const EMA_PERIODS = [3,5,8,9,12,15,18,21,25,30,35,40,50,100,200];

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
  const last = closes.length - 1;
  const prev = last - 1;
  const price = closes[last];
  const current = candles[last];
  const previous = candles[prev];
  const emaLines = {}, ema = {};
  for (const period of EMA_PERIODS) {
    emaLines[period] = emaSeries(closes, period);
    ema[period] = emaLines[period][last];
  }
  const rsi14 = rsi(closes, 14);
  const macd = macdData(closes);
  const atrValues = atrSeries(candles, 14);
  const atr14 = atrValues.length ? atrValues[last] : null;
  const adx14 = adxValue(candles, 14);
  const bb = bollinger(closes, 20, 2);

  // Wilder-style directional movement, calculated only from supplied OHLC candles.
  let plusDI = null, minusDI = null;
  if (candles.length >= 15) {
    let trSum = 0, plusSum = 0, minusSum = 0;
    for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      const up = c.high - p.high, down = p.low - c.low;
      trSum += Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close));
      plusSum += up > down && up > 0 ? up : 0;
      minusSum += down > up && down > 0 ? down : 0;
    }
    if (trSum > 0) { plusDI = plusSum / trSum * 100; minusDI = minusSum / trSum * 100; }
  }

  const prior = candles.slice(-21, -1);
  const priorHigh = Math.max(...prior.map(c => c.high));
  const priorLow = Math.min(...prior.map(c => c.low));
  const candleRange = Math.max(current.high-current.low, Number.EPSILON);
  const body = current.close-current.open;
  const bodyRatio = Math.abs(body)/candleRange;
  const upperWick = current.high-Math.max(current.open,current.close);
  const lowerWick = Math.min(current.open,current.close)-current.low;
  const atrBuffer = Number.isFinite(atr14) ? atr14 * 0.05 : 0;
  const bullishBreakout = current.close > priorHigh + atrBuffer && body > 0 && bodyRatio >= 0.55;
  const bearishBreakout = current.close < priorLow - atrBuffer && body < 0 && bodyRatio >= 0.55;

  const slopeUp = p => emaLines[p][last] > emaLines[p][Math.max(0,last-3)];
  const slopeDown = p => emaLines[p][last] < emaLines[p][Math.max(0,last-3)];
  const fastBull = ema[9] > ema[21] && slopeUp(9) && slopeUp(21);
  const fastBear = ema[9] < ema[21] && slopeDown(9) && slopeDown(21);
  const mediumBull = ema[50] > ema[100] && slopeUp(50) && slopeUp(100);
  const mediumBear = ema[50] < ema[100] && slopeDown(50) && slopeDown(100);
  const longBull = price > ema[200] && slopeUp(200);
  const longBear = price < ema[200] && slopeDown(200);
  const allBull = EMA_PERIODS.filter(p => price > ema[p]).length;
  const allBear = EMA_PERIODS.filter(p => price < ema[p]).length;
  // Trend direction uses the fast EMA structure plus price relative to EMA50.
  // Slower EMA alignment remains a weighted confirmation, not a hard veto.
  const trendUp = fastBull && price > ema[50] && slopeUp(50);
  const trendDown = fastBear && price < ema[50] && slopeDown(50);

  const macdBull = Number.isFinite(macd.histogram) && macd.line > macd.signal && macd.histogram > 0;
  const macdBear = Number.isFinite(macd.histogram) && macd.line < macd.signal && macd.histogram < 0;
  const rsiBull = Number.isFinite(rsi14) && rsi14 >= 52 && rsi14 <= 75;
  const rsiBear = Number.isFinite(rsi14) && rsi14 <= 48 && rsi14 >= 25;
  const strengthBull = Number.isFinite(adx14) && adx14 >= 18 && plusDI !== null && plusDI > minusDI * 1.08;
  const strengthBear = Number.isFinite(adx14) && adx14 >= 18 && minusDI !== null && minusDI > plusDI * 1.08;
  const pressure = calculatePressure(candles, 5);
  const pressureBull = pressure.confirmed && pressure.direction === "CALL";
  const pressureBear = pressure.confirmed && pressure.direction === "PUT";

  // Spot-FX volume is not supplied consistently by this feed; never fabricate a volume vote.
  const callChecks = [
    {name:"EMA 9/21 momentum",passed:fastBull,weight:20},
    {name:"EMA 50/100 trend",passed:mediumBull,weight:15},
    {name:"EMA 200 macro filter",passed:longBull,weight:15},
    {name:"15 EMA alignment",passed:allBull>=8,weight:10},
    {name:"Confirmed resistance breakout",passed:bullishBreakout,weight:20},
    {name:"RSI 14 momentum",passed:rsiBull,weight:5},
    {name:"MACD 12/26/9",passed:macdBull,weight:5},
    {name:"ADX/DMI strength",passed:strengthBull,weight:5},
    {name:"5-candle buying pressure",passed:pressureBull,weight:5}
  ];
  const putChecks = [
    {name:"EMA 9/21 momentum",passed:fastBear,weight:20},
    {name:"EMA 50/100 trend",passed:mediumBear,weight:15},
    {name:"EMA 200 macro filter",passed:longBear,weight:15},
    {name:"15 EMA alignment",passed:allBear>=8,weight:10},
    {name:"Confirmed support breakdown",passed:bearishBreakout,weight:20},
    {name:"RSI 14 momentum",passed:rsiBear,weight:5},
    {name:"MACD 12/26/9",passed:macdBear,weight:5},
    {name:"ADX/DMI strength",passed:strengthBear,weight:5},
    {name:"5-candle selling pressure",passed:pressureBear,weight:5}
  ];
  const callScore = callChecks.filter(x=>x.passed).reduce((s,x)=>s+x.weight,0);
  const putScore = putChecks.filter(x=>x.passed).reduce((s,x)=>s+x.weight,0);

  // A failed breakout close, long rejection wick, or exhausted candle blocks entry.
  const bullishReject = current.high > priorHigh && current.close < priorHigh && upperWick/candleRange >= 0.35;
  const bearishReject = current.low < priorLow && current.close > priorLow && lowerWick/candleRange >= 0.35;
  // Apply equal exhaustion and opposition filters to both directions.
  const bullishExhausted = rsi14 >= 80 || bodyRatio < 0.15 || upperWick/candleRange > 0.68;
  const bearishExhausted = rsi14 <= 20 || bodyRatio < 0.15 || lowerWick/candleRange > 0.68;
  const callOpposition = putScore >= 25;
  const putOpposition = callScore >= 25;

  // Breakout is a high-value bonus, not a mandatory condition. This also
  // allows confirmed trend-continuation entries before a 20-bar extreme breaks.
  const MIN_SIGNAL_SCORE = 55;
  const MIN_DIRECTIONAL_VOTES = 5;
  let direction = "STANDBY";
  let score = Math.max(callScore,putScore);
  const callVotes = callChecks.filter(x=>x.passed).length;
  const putVotes = putChecks.filter(x=>x.passed).length;
  const callReady = trendUp && callScore >= MIN_SIGNAL_SCORE && callVotes >= MIN_DIRECTIONAL_VOTES && !callOpposition && !bullishReject && !bullishExhausted;
  const putReady = trendDown && putScore >= MIN_SIGNAL_SCORE && putVotes >= MIN_DIRECTIONAL_VOTES && !putOpposition && !bearishReject && !bearishExhausted;
  if (callReady && !putReady) direction = "CALL";
  else if (putReady && !callReady) direction = "PUT";
  else direction = "STANDBY";

  const blockers = [];
  if (direction === "STANDBY") {
    if (!trendUp && !trendDown) blockers.push("EMA9/21 และตำแหน่งราคาเทียบ EMA50 ยังไม่ยืนยันทิศทาง");
    if (!bullishBreakout && !bearishBreakout) blockers.push("ยังไม่เกิด Breakout 20 แท่ง (เป็นคะแนนเสริม ไม่ใช่เงื่อนไขบังคับ)");
    if (callOpposition || putOpposition) blockers.push("พบแรงขัดแย้งจากฝั่งตรงข้าม");
    if (bullishReject || bearishReject) blockers.push("พบไส้เทียนปฏิเสธ Breakout (เสี่ยง Fakeout)");
    if (bullishExhausted || bearishExhausted) blockers.push("แท่งเทียนหรือ RSI อยู่ในภาวะเสี่ยงไล่ราคา");
    if (score < MIN_SIGNAL_SCORE) blockers.push("คะแนนเงื่อนไขยังไม่ถึง 55/100");
    if (Math.max(callVotes,putVotes) < MIN_DIRECTIONAL_VOTES) blockers.push("จำนวนกลยุทธ์ที่ยืนยันยังไม่ครบ 5 ข้อ");
  }

  const trend = trendUp ? "UP" : trendDown ? "DOWN" : "NEUTRAL";
  const emaValues = {};
  for (const p of EMA_PERIODS) emaValues[p] = round(ema[p]);
  const emaSignals = [];
  const chartStart = Math.max(0,candles.length-80);
  const chartCandles = candles.slice(chartStart).map((c,offset)=>{
    const i=chartStart+offset,emas={};
    for(const p of EMA_PERIODS) emas[p]=round(emaLines[p][i]);
    return {...c,emas};
  });

  const fakeout = {
    status: bullishReject || bearishReject ? "FAKEOUT_WATCH" : "NO_FAKEOUT",
    detected: Boolean(bullishReject || bearishReject),
    confirmed: false,
    originalDirection: direction === "STANDBY" ? null : direction,
    reversalDirection: null,
    score: (bullishReject || bearishReject) ? 60 : 0,
    evidence: [
      {label:"Close beyond prior 20-bar range",passed:bullishBreakout||bearishBreakout},
      {label:"Candle body >= 55% of range",passed:bodyRatio>=0.55},
      {label:"No long rejection wick",passed:!bullishReject&&!bearishReject}
    ],
    reason: bullishReject || bearishReject ? "พบการปฏิเสธราคาบริเวณกรอบเดิม จึงงดเข้าเพื่อป้องกัน Fakeout" : "ไม่พบสัญญาณปฏิเสธ Breakout ที่ชัดเจน"
  };

  const stopDistance = Number.isFinite(atr14) ? Math.max(atr14*1.2,Math.abs(body)*0.8) : null;
  const risk = direction !== "STANDBY" && stopDistance > 0 ? {
    entry:round(price),
    stopLoss:round(direction==="CALL"?price-stopDistance:price+stopDistance),
    takeProfit15:round(direction==="CALL"?price+stopDistance*1.5:price-stopDistance*1.5),
    takeProfit20:round(direction==="CALL"?price+stopDistance*2:price-stopDistance*2),
    riskReward:"1:1.5 / 1:2",
    method:"ATR(14) based reference levels; not broker-executed"
  } : null;

  const checks = direction==="CALL"?callChecks:direction==="PUT"?putChecks:[];
  const alignedVotes = checks.filter(x=>x.passed).length;
  const strategyVotes = (direction==="PUT"?putChecks:callChecks).map(x=>({
    name:x.name,direction:x.passed?(direction==="STANDBY"?"PASS":"PASS"):"WAIT",
    weight:x.weight,detail:x.passed?"ผ่านเงื่อนไข":"ยังไม่ผ่าน"
  }));
  const signal = direction==="STANDBY"?null:{
    id:String(current.datetime)+":MOMENTUM_BREAKOUT:"+direction,
    direction,score:Math.min(100,score),alignedVotes,directionalVotes:checks.length,
    candleTime:current.datetime,
    reason:(direction==="CALL"?"แนวโน้มขึ้น + แรงส่งยืนยัน":"แนวโน้มลง + แรงส่งยืนยัน")+" · EMA 15 เส้น + RSI/MACD/ADX"+(direction==="CALL"&&bullishBreakout||direction==="PUT"&&bearishBreakout?" + Breakout":"")+" ยืนยัน"
  };
  const indicators = {
    rsi14:round(rsi14,2),macdLine:round(macd.line,8),macdSignal:round(macd.signal,8),
    macdHistogram:round(macd.histogram,8),atr14:round(atr14,8),adx14:round(adx14,2),
    plusDI:round(plusDI,2),minusDI:round(minusDI,2),
    bollinger:bb?{upper:round(bb.upper),middle:round(bb.middle),lower:round(bb.lower),width:round(bb.width,3)}:null,
    pressure,ema50:round(ema[50]),ema100:round(ema[100]),ema200:round(ema[200]),
    emaAlignment:{bullish:allBull,bearish:allBear,total:EMA_PERIODS.length},
    breakout:{direction:bullishBreakout?"CALL":bearishBreakout?"PUT":null,priorHigh:round(priorHigh),priorLow:round(priorLow),bodyRatio:round(bodyRatio,3)},
    strategyVotes:strategyVotes,callWeight:callScore,putWeight:putScore,activeWeight:callScore+putScore,
    risk
  };
  const analysis = {
    engine:"BALANCED_TREND_MOMENTUM_V3",
    dataSource:"Twelve Data 1-minute OHLC",
    calculationSource:"คำนวณ EMA/RSI/MACD/ADX/ATR และ Breakout จากแท่ง OHLC ที่ปิดแล้ว",
    mode:"Trend Following + Momentum Confluence + optional 20-bar Breakout · EMA 15 เส้น",
    filter:"EMA9_21_EMA50_AND_WEIGHTED_CONFIRMATION",
    trend,score,direction,passed:Boolean(signal),
    callVotes:callChecks.filter(x=>x.passed).length,
    putVotes:putChecks.filter(x=>x.passed).length,
    callWeight:callScore,putWeight:putScore,alignedVotes,
    totalStrategies:9,requiredVotes:MIN_DIRECTIONAL_VOTES,minimumScore:MIN_SIGNAL_SCORE,
    blockers, strategyVotes,
    breakout:indicators.breakout, fakeout, risk,
    note:"ไม่มี Volume จริงในข้อมูล OHLC ชุดนี้ จึงไม่ใช้หรือสร้างตัวเลข Volume ปลอม"
  };
  return {price,candle:current,emaValues,emaSignals,chartCandles,trend,indicators,analysis,signal,fakeout,score:signal?signal.score:0,closes};
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