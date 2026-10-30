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
const EMA_PERIODS = [3,5,8,9,12,15,18,20,21,25,30,35,40,50,100,200];

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
  const price = closes[last], current = candles[last], previous = candles[prev];
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
  const stochastic14 = stochastic(candles, 14, 3);
  const cci20 = cci(candles, 20);
  const williams14 = williamsR(candles, 14);

  // EMA 5/20 cross is the sole primary entry trigger; only completed candles are supplied here.
  const crossedUp = emaLines[5][prev] <= emaLines[20][prev] && ema[5] > ema[20];
  const crossedDown = emaLines[5][prev] >= emaLines[20][prev] && ema[5] < ema[20];
  const closeAboveBoth = price > ema[5] && price > ema[20];
  const closeBelowBoth = price < ema[5] && price < ema[20];

  // ATR must show minimum movement; volume must be present and above its previous-20-candle average.
  const volumeWindow = candles.slice(Math.max(0, last - 20), last).map(c => Number(c.volume));
  const currentVolume = Number(current.volume);
  const volumeAvailable = volumeWindow.length === 20 &&
    [...volumeWindow, currentVolume].every(v => Number.isFinite(v) && v > 0);
  const averageVolume = volumeAvailable ? volumeWindow.reduce((sum,v)=>sum+v,0)/20 : null;
  const volumeRatio = volumeAvailable && averageVolume > 0 ? currentVolume / averageVolume : null;
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1.05;
  const atrConfirmed = Number.isFinite(atr14) && price > 0 && atr14 / price >= 0.00003;
  const rsiBuy = Number.isFinite(rsi14) && rsi14 > 50;
  const rsiSell = Number.isFinite(rsi14) && rsi14 < 50;

  // Trap confirmation: a long rejection wick on the prior closed candle followed
  // by a close through that candle's opposite extreme on the current closed candle.
  const shape = c => {
    const body = Math.max(Math.abs(c.close-c.open), Number.EPSILON);
    return {body, upper:c.high-Math.max(c.open,c.close), lower:Math.min(c.open,c.close)-c.low};
  };
  const prevShape = shape(previous);
  const bullTrap = previous.close > previous.open &&
    prevShape.upper >= prevShape.body * 1.5 && current.close < previous.low;
  const bearTrap = previous.close < previous.open &&
    prevShape.lower >= prevShape.body * 1.5 && current.close > previous.high;

  let direction = "STANDBY", score = 0;
  let reason = "ยังไม่มี EMA 5/20 crossover ที่ผ่านตัวกรองทั้งหมด";
  const commonFiltersPass = atrConfirmed && volumeConfirmed;
  if (!volumeAvailable) {
    reason = "ไม่มีข้อมูล Volume จริงครบ 21 แท่งจากผู้ให้บริการ จึงงดส่งสัญญาณ";
  } else if (!volumeConfirmed) {
    reason = "Volume ยังไม่ยืนยันแรงซื้อขาย (ต้องไม่น้อยกว่า 1.05 เท่าของค่าเฉลี่ย 20 แท่ง)";
  } else if (!atrConfirmed) {
    reason = "ATR 14 ต่ำกว่าเกณฑ์ ตลาดนิ่งเกินไป จึงงดเข้าออเดอร์";
  } else if (bullTrap && rsiSell) {
    direction = "PUT"; score = 85;
    reason = "Bull Trap confirmed: แท่งก่อนมีไส้บนยาวและแท่งปิดล่าสุดหลุด Low ของแท่งกับดัก";
  } else if (bearTrap && rsiBuy) {
    direction = "CALL"; score = 85;
    reason = "Bear Trap confirmed: แท่งก่อนมีไส้ล่างยาวและแท่งปิดล่าสุดทะลุ High ของแท่งกับดัก";
  } else if (commonFiltersPass && crossedUp && closeAboveBoth && rsiBuy) {
    direction = "CALL"; score = 80;
    reason = "EMA 5 ตัดขึ้น EMA 20, แท่งปิดเหนือทั้งสองเส้น, RSI 14 > 50, ATR และ Volume ผ่าน";
  } else if (commonFiltersPass && crossedDown && closeBelowBoth && rsiSell) {
    direction = "PUT"; score = 80;
    reason = "EMA 5 ตัดลง EMA 20, แท่งปิดต่ำกว่าทั้งสองเส้น, RSI 14 < 50, ATR และ Volume ผ่าน";
  } else if (!crossedUp && !crossedDown) {
    reason = "รอ EMA 5 ตัด EMA 20 บนแท่งที่ปิดแล้ว";
  } else if ((crossedUp && !closeAboveBoth) || (crossedDown && !closeBelowBoth)) {
    reason = "พบ EMA crossover แต่ราคาปิดยังไม่ยืนยันทิศทางเหนือ/ใต้ทั้งสองเส้น";
  } else if ((crossedUp && !rsiBuy) || (crossedDown && !rsiSell)) {
    reason = "RSI 14 ยังไม่ยืนยันโซนแรงซื้อ/แรงขาย";
  }

  const trend = ema[5] > ema[20] ? "UP" : ema[5] < ema[20] ? "DOWN" : "NEUTRAL";
  const emaValues = {};
  for (const p of EMA_PERIODS) emaValues[p] = round(ema[p]);
  const chartStart = Math.max(0, candles.length - 80);
  const chartCandles = candles.slice(chartStart).map((c,offset) => {
    const i = chartStart + offset, emas = {};
    for (const p of EMA_PERIODS) emas[p] = round(emaLines[p][i]);
    return {...c, emas};
  });

  const fakeout = {
    status: bullTrap || bearTrap ? "REVERSAL_CONFIRMED" : "NO_FAKEOUT",
    detected: Boolean(bullTrap || bearTrap),
    confirmed: Boolean(bullTrap || bearTrap),
    originalDirection: bullTrap ? "CALL" : bearTrap ? "PUT" : null,
    reversalDirection: bullTrap ? "PUT" : bearTrap ? "CALL" : null,
    score: bullTrap || bearTrap ? 85 : 0,
    evidence: [
      {label:"Previous candle long rejection wick",passed:Boolean(bullTrap || bearTrap)},
      {label:"Latest closed candle broke trap candle opposite extreme",passed:Boolean(bullTrap || bearTrap)},
      {label:"RSI confirms reversal side",passed:Boolean((bullTrap && rsiSell) || (bearTrap && rsiBuy))}
    ],
    reason: bullTrap ? "Bull Trap: กลับฝั่งเป็น PUT" : bearTrap ? "Bear Trap: กลับฝั่งเป็น CALL" : "ไม่พบกับดักที่ยืนยันด้วยแท่งปิด"
  };

  const riskDistance = Number.isFinite(atr14) ? atr14 * 1.2 : null;
  const risk = direction !== "STANDBY" && riskDistance > 0 ? {
    entry:round(price),
    stopLoss:round(direction==="CALL" ? price-riskDistance : price+riskDistance),
    takeProfit15:round(direction==="CALL" ? price+riskDistance*1.5 : price-riskDistance*1.5),
    takeProfit20:round(direction==="CALL" ? price+riskDistance*2 : price-riskDistance*2),
    riskReward:"1:1.5 / 1:2",
    method:"ATR(14) reference levels; no broker order execution"
  } : null;

  const checks = [
    {name:"EMA 5/20 crossover",passed:direction!=="STANDBY" && (crossedUp||crossedDown),weight:35},
    {name:"Closed candle above/below both EMAs",passed:direction==="CALL"?closeAboveBoth:direction==="PUT"?closeBelowBoth:false,weight:20},
    {name:"RSI 14 zone confirmation",passed:direction==="CALL"?rsiBuy:direction==="PUT"?rsiSell:false,weight:15},
    {name:"ATR 14 volatility filter",passed:atrConfirmed,weight:15},
    {name:"Volume confirmation >= 1.05x",passed:volumeConfirmed,weight:15}
  ];
  const strategyVotes = checks.map(x=>({name:x.name,direction:x.passed?"PASS":"WAIT",weight:x.weight,detail:x.passed?"ผ่านเงื่อนไข":"ยังไม่ผ่าน"}));
  const signal = direction === "STANDBY" ? null : {
    id:String(current.datetime)+":EMA5-20:"+direction,
    direction, originalDirection:bullTrap?"CALL":bearTrap?"PUT":direction,
    score, alignedVotes:checks.filter(x=>x.passed).length, directionalVotes:5,
    candleTime:current.datetime, reason
  };
  const indicators = {
    rsi14:round(rsi14,2), macdLine:round(macd.line,8), macdSignal:round(macd.signal,8),
    macdHistogram:round(macd.histogram,8), atr14:round(atr14,8), adx14:round(adx14,2),
    plusDI:null, minusDI:null,
    bollinger:bb?{upper:round(bb.upper),middle:round(bb.middle),lower:round(bb.lower),width:round(bb.width,3)}:null,
    stochastic:stochastic14?{k:round(stochastic14.k,2),d:round(stochastic14.d,2)}:null,
    cci20:round(cci20,2), williamsR14:round(williams14,2),
    pressure:{buy:null,sell:null,delta:null,confirmed:false,direction:"NOT_USED",reason:"ไม่ได้ใช้เป็นเงื่อนไขหลักของกลยุทธ์ EMA 5/20"},
    ema5:round(ema[5]), ema20:round(ema[20]),
    emaAlignment:{bullish:ema[5]>ema[20]?1:0,bearish:ema[5]<ema[20]?1:0,total:1},
    breakout:{direction:null,priorHigh:null,priorLow:null,bodyRatio:null},
    strategyVotes,callWeight:direction==="CALL"?score:0,putWeight:direction==="PUT"?score:0,
    activeWeight:score,volumeRatio:round(volumeRatio,3),volumeConfirmed,atrConfirmed,risk
  };
  const blockers = direction==="STANDBY" ? [reason] : [];
  const analysis = {
    engine:"EMA_5_20_TREND_MOMENTUM_TRAP_V1",
    dataSource:"Twelve Data 1-minute OHLC",
    calculationSource:"คำนวณ EMA5/EMA20, RSI14, ATR14 และ Volume จากแท่งเทียนที่ปิดแล้วเท่านั้น",
    mode:"EMA 5/20 Trend Following + RSI/ATR/Volume Confirmation + Bull/Bear Trap",
    filter:"CLOSED_CANDLE_EMA5_20_RSI_ATR_VOLUME_TRAP",
    trend,score,direction,passed:Boolean(signal),
    callVotes:direction==="CALL"?checks.filter(x=>x.passed).length:0,
    putVotes:direction==="PUT"?checks.filter(x=>x.passed).length:0,
    callWeight:direction==="CALL"?score:0,putWeight:direction==="PUT"?score:0,
    alignedVotes:checks.filter(x=>x.passed).length,totalStrategies:5,requiredVotes:5,minimumScore:80,
    blockers,strategyVotes,breakout:indicators.breakout,fakeout,risk,
    note:"ไม่สร้าง Volume ปลอมหรือแทน Volume ด้วย tick/price movement; หาก Twelve Data ไม่ส่ง Volume จะไม่ออกสัญญาณ"
  };
  return {price,candle:current,emaValues,emaSignals:signal?[{...signal,ema:"5/20"}]:[],
    chartCandles,trend,indicators,analysis,signal,fakeout,score:signal?signal.score:0,closes};
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
  const candles = completed.map(c=>({datetime:c.datetime||null,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:c.volume===undefined||c.volume===null||c.volume===""?null:Number(c.volume)}));
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