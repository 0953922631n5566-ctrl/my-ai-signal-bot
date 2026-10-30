"use strict";

const express = require("express");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.FOREX_PAIR || "EUR/USD";
const POLL_MS = Math.max(60000, Number(process.env.POLL_INTERVAL_MS) || 60000);
const MIN_SCORE = Math.min(95, Math.max(70, Number(process.env.MIN_SIGNAL_SCORE) || 78));
const MAX_DATA_AGE_MS = 90000;
const SIGNAL_DURATION_MS = 40000;
const EMA_PERIODS = [3, 5, 8, 9, 12, 15, 18, 21, 25, 30, 35, 40, 50, 75, 100];

const state = {
  source: "Twelve Data", symbol: SYMBOL, interval: "1min",
  price: null, candleTime: null, fetchedAt: null, fetchedAtMs: 0,
  emaValues: {}, emaSignals: [], marketTrend: "NEUTRAL",
  rsi14: null, macd: null, bullVotes: 0, bearVotes: 0,
  score: 0, candidate: "STANDBY", reason: "กำลังรอข้อมูลตลาด",
  aiSignal: null, aiAnalysis: null, technicalIndicators: {},
  error: null, candles: [], lastPollAt: null, nextPollAt: null
};

let pollInProgress = false;
let pollTimer = null;

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

function analyzeMarket(candles) {
  const closes = candles.map(c => c.close), last = closes.length - 1, prev = last - 1;
  const ema = {}, emaLines = {};
  for (const p of EMA_PERIODS) { emaLines[p] = emaSeries(closes, p); ema[p] = emaLines[p][last]; }
  const ema50Slope = emaLines[50][last] - emaLines[50][last - 3];
  const ema100Slope = emaLines[100][last] - emaLines[100][last - 3];
  const price = closes[last], candle = candles[last], previous = candles[prev];
  const rsi14 = rsi(closes, 14), macd = macdData(closes), atr14 = atrSeries(candles, 14).at(-1);
  const adx14 = adxValue(candles, 14), bands = bollinger(closes, 20);
  const stoch = stochastic(candles, 14, 3), cci20 = cci(candles, 20), wr14 = williamsR(candles, 14);
  if (![rsi14, macd.histogram, atr14, adx14, bands?.middle, stoch?.k, cci20, wr14].every(Number.isFinite)) {
    throw new Error("ข้อมูลแท่งเทียนไม่เพียงพอสำหรับ AI indicators");
  }

  let trend = "NEUTRAL";
  if (ema[50] > ema[100] && ema50Slope > 0 && ema100Slope >= 0 && price > ema[50]) trend = "UP";
  else if (ema[50] < ema[100] && ema50Slope < 0 && ema100Slope <= 0 && price < ema[50]) trend = "DOWN";

  // Adaptive voting: indicator weights change with trend strength/regime.
  const strongTrend = adx14 >= 25;
  const weights = {
    trend: strongTrend ? 2.2 : 1.7, macd: strongTrend ? 1.5 : 1.1,
    rsi: 1.0, stochastic: 0.8, cci: 0.8, williams: 0.6, bollinger: 0.8, candle: 0.7
  };
  const votes = [
    { key:"trend", label:"EMA trend", direction: trend === "UP" ? "CALL" : trend === "DOWN" ? "PUT" : null, weight:weights.trend, detail:"EMA50/100 + slope + price" },
    { key:"macd", label:"MACD", direction:macd.histogram > 0 ? "CALL" : macd.histogram < 0 ? "PUT" : null, weight:weights.macd, detail:"Histogram " + round(macd.histogram,8) },
    { key:"rsi", label:"RSI", direction:rsi14 >= 52 ? "CALL" : rsi14 <= 48 ? "PUT" : null, weight:weights.rsi, detail:"RSI " + round(rsi14,2) },
    { key:"stochastic", label:"Stochastic", direction:stoch.k > stoch.d && stoch.k < 85 ? "CALL" : stoch.k < stoch.d && stoch.k > 15 ? "PUT" : null, weight:weights.stochastic, detail:"%K " + round(stoch.k,1) + " / %D " + round(stoch.d,1) },
    { key:"cci", label:"CCI", direction:cci20 >= 50 ? "CALL" : cci20 <= -50 ? "PUT" : null, weight:weights.cci, detail:"CCI " + round(cci20,1) },
    { key:"williams", label:"Williams %R", direction:wr14 > -50 ? "CALL" : wr14 < -50 ? "PUT" : null, weight:weights.williams, detail:"%R " + round(wr14,1) },
    { key:"bollinger", label:"Bollinger mid", direction:price > bands.middle ? "CALL" : price < bands.middle ? "PUT" : null, weight:weights.bollinger, detail:"ตำแหน่งเทียบเส้นกลาง" },
    { key:"candle", label:"Price action", direction:candle.close > candle.open ? "CALL" : candle.close < candle.open ? "PUT" : null, weight:weights.candle, detail:"แท่งปิดล่าสุด" }
  ];
  const totalWeight = votes.reduce((s,v)=>s+v.weight,0);
  const callWeight = votes.filter(v=>v.direction==="CALL").reduce((s,v)=>s+v.weight,0);
  const putWeight = votes.filter(v=>v.direction==="PUT").reduce((s,v)=>s+v.weight,0);
  const direction = callWeight > putWeight ? "CALL" : putWeight > callWeight ? "PUT" : "STANDBY";
  const winningWeight = Math.max(callWeight, putWeight);
  const score = totalWeight ? Math.round(winningWeight / totalWeight * 100) : 0;
  const alignedVotes = votes.filter(v=>v.direction===direction).length;
  const directionalVotes = votes.filter(v=>v.direction).length;
  const tooExtended = atr14 > 0 && Math.abs(price - ema[21]) > atr14 * 1.8;
  const gates = {
    trendAligned: (direction === "CALL" && trend === "UP") || (direction === "PUT" && trend === "DOWN"),
    adxStrongEnough: adx14 >= 18,
    confluence: alignedVotes >= 6 && score >= MIN_SCORE,
    notOverextended: !tooExtended,
    candleClosed: true
  };
  const passed = Object.values(gates).every(Boolean) && direction !== "STANDBY";
  const reasons = [];
  if (!gates.trendAligned) reasons.push("ทิศทางยังไม่ตรงกับแนวโน้ม EMA50/100");
  if (!gates.adxStrongEnough) reasons.push("ADX ต่ำกว่า 18");
  if (!gates.confluence) reasons.push("คะแนนหรือจำนวน Indicator ที่เห็นตรงกันยังไม่ถึงเกณฑ์");
  if (!gates.notOverextended) reasons.push("ราคาเคลื่อนห่าง EMA21 เกิน 1.8 ATR");
  if (!gates.candleClosed) reasons.push("รอแท่งปิด");
  const signal = passed ? {
    id: String(candle.datetime) + ":AI:" + direction,
    direction, score, alignedVotes, directionalVotes,
    candleTime:candle.datetime,
    reason:"AI เห็นพ้อง " + alignedVotes + "/8 เครื่องมือ · ADX " + round(adx14,1) + " · " + (trend === "UP" ? "แนวโน้มขาขึ้น" : "แนวโน้มขาลง")
  } : null;

  const emaSignals = [];
  for (const period of EMA_PERIODS) {
    const prevEma = emaLines[period][prev], currEma = emaLines[period][last];
    const up = closes[prev] <= prevEma && price > currEma;
    const down = closes[prev] >= prevEma && price < currEma;
    if (signal && ((up && direction === "CALL") || (down && direction === "PUT"))) {
      emaSignals.push({
        id:String(candle.datetime)+":EMA"+period+":"+direction,
        ema:period, direction, score, candleTime:candle.datetime,
        reason:"EMA " + period + " ตัดตามสัญญาณ AI"
      });
    }
  }

  const emaValues = {};
  for (const p of EMA_PERIODS) emaValues[p] = round(ema[p]);
  const chartStart = Math.max(0, candles.length - 80);
  const chartCandles = candles.slice(chartStart).map((c, offset) => {
    const i = chartStart + offset, emas = {};
    for (const p of EMA_PERIODS) emas[p] = round(emaLines[p][i]);
    return { ...c, emas };
  });
  const indicators = {
    rsi14:round(rsi14,2), macd:round(macd.line,8), macdSignal:round(macd.signal,8),
    macdHistogram:round(macd.histogram,8), adx14:round(adx14,2), atr14:round(atr14,8),
    bollinger:{ upper:round(bands.upper), middle:round(bands.middle), lower:round(bands.lower), width:round(bands.width,3) },
    stochastic:{ k:round(stoch.k,2), d:round(stoch.d,2) },
    cci20:round(cci20,2), williamsR14:round(wr14,2),
    sma20:round(sma(closes,20)), sma50:round(sma(closes,50))
  };
  const analysis = {
    engine:"ADAPTIVE_MULTI_INDICATOR", mode:"AI เลือกน้ำหนักตามสภาพตลาด",
    filter:"STRICT", trend, adxStrength:strongTrend?"STRONG":"MODERATE",
    score, direction, alignedVotes, directionalVotes, requiredVotes:6,
    minScore:MIN_SCORE, passed, gates, votes: votes.map(v=>({...v, aligned:v.direction===direction})),
    blockers:reasons.length ? reasons : ["ผ่านเกณฑ์ AI ทุกชั้น"]
  };
  return { price, candle, emaValues, emaLines, emaSignals, chartCandles, trend, indicators, analysis, signal, score, closes };
}

async function fetchMarketData() {
  if (!API_KEY) throw new Error("ยังไม่ได้ตั้ง TWELVE_DATA_API_KEY ใน Render Environment Variables");
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", SYMBOL);
  url.searchParams.set("interval", "1min");
  url.searchParams.set("outputsize", "120");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", API_KEY);
  const response = await fetch(url, { signal:AbortSignal.timeout(15000), headers:{Accept:"application/json"} });
  if (!response.ok) throw new Error("Twelve Data HTTP " + response.status);
  const json = await response.json();
  if (json.status === "error" || json.code || !Array.isArray(json.values)) throw new Error(json.message || "Twelve Data ไม่ส่งข้อมูลแท่งเทียน");

  const now = Date.now();
  const completed = json.values.slice().reverse().filter(c => {
    const opened = Date.parse(String(c.datetime || "").replace(" ","T") + "Z");
    return Number.isFinite(opened) && opened + 60000 <= now;
  });
  if (completed.length < 105) throw new Error("ต้องมีแท่งเทียนปิดแล้วอย่างน้อย 105 แท่งสำหรับ EMA100 และ AI indicators");
  const candles = completed.map(c=>({datetime:c.datetime||null,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)}));
  if (candles.some(c=>[c.open,c.high,c.low,c.close].some(v=>!Number.isFinite(v)||v<=0)||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close))) {
    throw new Error("ข้อมูล OHLC ที่ได้รับไม่ถูกต้อง");
  }
  const result = analyzeMarket(candles);
  const stamp = Date.now();
  const bullVotes = Object.values(result.emaValues).filter(v=>result.price>v).length;
  const bearVotes = Object.values(result.emaValues).filter(v=>result.price<v).length;
  Object.assign(state,{
    price:round(result.price), candleTime:result.candle.datetime,
    fetchedAt:new Date(stamp).toISOString(), fetchedAtMs:stamp,
    emaValues:result.emaValues, emaSignals:result.emaSignals, marketTrend:result.trend,
    rsi14:result.indicators.rsi14, macd:result.indicators.macdHistogram,
    technicalIndicators:result.indicators, aiAnalysis:result.analysis, aiSignal:result.signal,
    bullVotes,bearVotes,score:result.signal?result.signal.score:0,
    candidate:result.signal?result.signal.direction:"STANDBY",
    reason:result.signal?result.signal.reason:"STANDBY · "+result.analysis.blockers.join(" / "),
    candles:result.chartCandles,error:null,lastPollAt:new Date(stamp).toISOString(),
    nextPollAt:new Date(stamp+POLL_MS).toISOString()
  });
  console.log("[AI SCAN] "+SYMBOL+" price="+state.price+" trend="+state.marketTrend+
    " score="+result.analysis.score+" votes="+result.analysis.alignedVotes+"/8"+
    " ADX="+result.indicators.adx14+" signal="+state.candidate);
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
    source:state.source,symbol:state.symbol,interval:state.interval,price:state.price,
    candleTime:state.candleTime,fetchedAt:state.fetchedAt,dataAgeMs:Number.isFinite(age)?age:null,dataFresh:fresh,
    emaPeriods:EMA_PERIODS,emaValues:state.emaValues,emaSignals:fresh?state.emaSignals:[],
    marketTrend:fresh?state.marketTrend:"NEUTRAL",candles:fresh?state.candles:[],
    rsi14:state.rsi14,macd:state.macd,bullVotes:state.bullVotes,bearVotes:state.bearVotes,
    technicalIndicators:fresh?state.technicalIndicators:{},aiAnalysis:fresh?state.aiAnalysis:null,
    aiSignal:fresh?state.aiSignal:null,score:fresh?state.score:0,
    candidate:fresh?state.candidate:"STANDBY",reason:fresh?state.reason:"ข้อมูลตลาดเก่าหรือยังไม่พร้อม",
    error:state.error,lastPollAt:state.lastPollAt,nextPollAt:state.nextPollAt,
    serverTime:Date.now(),signalDurationMs:SIGNAL_DURATION_MS,minScore:MIN_SCORE
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
      reason:d.reason,emaSignals:d.emaSignals,aiSignal:d.aiSignal,aiAnalysis:d.aiAnalysis}]});
});
async function handleScan(req,res){
  res.set("Cache-Control","no-store");
  const age=state.fetchedAtMs?Date.now()-state.fetchedAtMs:Infinity;
  if((!state.fetchedAtMs||age>=POLL_MS)&&!pollInProgress) await pollMarket();
  const d=publicState();res.status(d.error&&!d.fetchedAt?503:200).json({ok:!d.error&&d.dataFresh,...d});
}
app.get("/api/scan",handleScan);app.post("/api/scan",handleScan);
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
function scheduleNextPoll() {
  // Align one fetch to just after each UTC minute boundary so the newly closed
  // one-minute candle is evaluated once it becomes available from the provider.
  const delay = Math.max(1000, 60000 - (Date.now() % 60000) + 1500);
  state.nextPollAt = new Date(Date.now() + delay).toISOString();
  pollTimer = setTimeout(async () => {
    await pollMarket();
    scheduleNextPoll();
  }, delay);
}
app.listen(PORT,async()=>{console.log("AI Signal Radar running on port "+PORT);await pollMarket();scheduleNextPoll();});
process.on("SIGTERM",()=>{if(pollTimer)clearTimeout(pollTimer);process.exit(0);});
