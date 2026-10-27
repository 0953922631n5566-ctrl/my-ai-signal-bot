"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY || "";
const POLL_INTERVAL_MS = Math.max(60000, Number(process.env.POLL_INTERVAL_MS || 60000));
const MIN_CANDLES = 100;
const STALE_AFTER_MS = 4 * 60 * 1000;
let dynamicThreshold = clamp(Number(process.env.DEFAULT_THRESHOLD || 62), 40, 95);
let activeClients = 0, scanInProgress = false, scanTimer = null;
let lastScanAt = null, lastError = null, lastManualScanTime = 0;

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","NZD/USD","EUR/GBP"];
const pairsCache = new Map(PAIRS.map(symbol => [symbol, {
  symbol, name:symbol, signal:"STANDBY", score:0, confidence:0, price:null,
  candleTime:null, updatedAt:null, dataStatus:"WAITING", reason:"รอสแกนข้อมูล", indicators:{}
}]));
const state = {
  symbol:"EUR/USD", timeframe:"1min", signal:"STANDBY", score:0, confidence:0,
  price:null, candleTime:null, updatedAt:null, dataStatus:"WAITING",
  reason:"รอข้อมูลตลาด", indicators:{}, threshold:dynamicThreshold
};

app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname,"public")));

function clamp(n,min,max){ return Math.max(min,Math.min(max,n)); }
function round(n,d=2){ if(!Number.isFinite(n)) return null; const f=10**d; return Math.round(n*f)/f; }
function mean(a){ return a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN; }
function stddev(a){ if(a.length<2)return 0; const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); }
function emaSeries(values,period){
  const out=Array(values.length).fill(null); if(values.length<period)return out;
  let e=mean(values.slice(0,period)); out[period-1]=e; const alpha=2/(period+1);
  for(let i=period;i<values.length;i++){e=values[i]*alpha+e*(1-alpha);out[i]=e;} return out;
}
function rsiSeries(values,period=14){
  const out=Array(values.length).fill(null); if(values.length<=period)return out;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const ch=values[i]-values[i-1];gain+=Math.max(0,ch);loss+=Math.max(0,-ch);}
  let ag=gain/period, al=loss/period;
  out[period]=al===0?(ag===0?50:100):100-100/(1+ag/al);
  for(let i=period+1;i<values.length;i++){const ch=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(0,ch))/period;al=(al*(period-1)+Math.max(0,-ch))/period;out[i]=al===0?(ag===0?50:100):100-100/(1+ag/al);}
  return out;
}
function parseTime(v){
  if(!v)return null; const s=String(v).trim().replace(" ","T");
  const t=Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(s)?s:s+"Z"); return Number.isFinite(t)?t:null;
}
async function fetchCandles(symbol, outputsize=200){
  if(!API_KEY)throw new Error("ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render");
  const url=new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol",symbol); url.searchParams.set("interval","1min");
  url.searchParams.set("outputsize",String(clamp(Number(outputsize)||200,100,5000)));
  url.searchParams.set("timezone","UTC"); url.searchParams.set("apikey",API_KEY);
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),20000);
  let response;
  try{response=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json"}});}
  catch(e){throw new Error(e.name==="AbortError"?"Twelve Data ตอบกลับช้าเกินกำหนด":"เชื่อมต่อ Twelve Data ไม่สำเร็จ");}
  finally{clearTimeout(timer);}
  if(!response.ok)throw new Error(`Twelve Data HTTP ${response.status}`);
  const body=await response.json();
  if(body.status==="error"||body.code||(body.message&&!body.values))throw new Error(String(body.message||body.code||"Twelve Data API error").slice(0,200));
  if(!Array.isArray(body.values))throw new Error("API ไม่ส่งข้อมูลแท่งเทียนกลับมา");
  const list=body.values.map(x=>({time:parseTime(x.datetime),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)}))
   .filter(c=>c.time!==null&&[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.open>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.high>=c.low)
   .sort((a,b)=>a.time-b.time);
  const unique=new Map(); for(const c of list)unique.set(c.time,c); return [...unique.values()];
}
function analyzeCandles(candles, options={}){
  if(!Array.isArray(candles)||candles.length<MIN_CANDLES)throw new Error(`ต้องมีข้อมูลอย่างน้อย ${MIN_CANDLES} แท่ง`);
  const closes=candles.map(c=>c.close), latest=candles.at(-1);
  const e5=emaSeries(closes,5),e9=emaSeries(closes,9),e21=emaSeries(closes,21),e50=emaSeries(closes,50),e100=emaSeries(closes,100),rsi=rsiSeries(closes,14);
  const m12=emaSeries(closes,12),m26=emaSeries(closes,26);
  const macd=closes.map((_,i)=>m12[i]!==null&&m26[i]!==null?m12[i]-m26[i]:null);
  const macdValid=macd.filter(Number.isFinite),sigSeries=emaSeries(macdValid,9);
  const macdNow=macd.at(-1), macdSignal=sigSeries.at(-1), rsiNow=rsi.at(-1);
  const recent=closes.slice(-20), mid=mean(recent), sd=stddev(recent);
  let bull=0,bear=0; const reasons=[];
  const vote=(up,down,w,label)=>{if(up){bull+=w;reasons.push(label+": ขาขึ้น");}else if(down){bear+=w;reasons.push(label+": ขาลง");}};
  vote(e5.at(-1)>e9.at(-1)&&e9.at(-1)>e21.at(-1),e5.at(-1)<e9.at(-1)&&e9.at(-1)<e21.at(-1),2,"EMA 5/9/21");
  vote(e21.at(-1)>e50.at(-1),e21.at(-1)<e50.at(-1),2,"EMA 21/50");
  vote(latest.close>e100.at(-1),latest.close<e100.at(-1),2,"EMA 100");
  vote(rsiNow>=50&&rsiNow<72,rsiNow<=50&&rsiNow>28,1.5,"RSI");
  vote(macdNow>macdSignal,macdNow<macdSignal,2,"MACD");
  vote(latest.close>latest.open,latest.close<latest.open,1,"Price action");
  vote(latest.close>mid,latest.close<mid,1,"Bollinger middle");
  const total=bull+bear, winning=Math.max(bull,bear), score=total?Math.round(100*winning/total):0;
  const agreement=total?winning/total:0;
  const referenceTime=Number.isFinite(options.referenceTime)?options.referenceTime:Date.now();
  const age=referenceTime-latest.time;
  const fresh=options.backtest===true ? true : age>=-60000&&age<=STALE_AFTER_MS;
  let signal="STANDBY",reason="ตัวชี้วัดยังไม่ยืนยันไปในทิศทางเดียวกัน";
  if(!fresh)reason="ข้อมูลแท่งเทียนเก่าหรือเวลาไม่ตรง";
  else if(score<dynamicThreshold||agreement<0.55)reason=`คะแนนไม่ถึงเกณฑ์ (${score}/${dynamicThreshold}%)`;
  else if(bull>bear&&rsiNow<75){signal="CALL";reason="แนวโน้มและโมเมนตัมเอนเอียงขึ้น";}
  else if(bear>bull&&rsiNow>25){signal="PUT";reason="แนวโน้มและโมเมนตัมเอนเอียงลง";}
  return {signal,score,confidence:score,reason,reasons:reasons.slice(-8),indicators:{
    ema5:round(e5.at(-1),6),ema9:round(e9.at(-1),6),ema21:round(e21.at(-1),6),ema50:round(e50.at(-1),6),ema100:round(e100.at(-1),6),
    rsi14:round(rsiNow),macd:round(macdNow,6),macdSignal:round(macdSignal,6),bollingerMiddle:round(mid,6),
    bullishPoints:round(bull),bearishPoints:round(bear),agreement:round(agreement*100,1),candleAgeSeconds:Math.max(0,Math.round(age/1000))
  }};
}
function getPairs(){return PAIRS.map(s=>pairsCache.get(s));}
function buildPayload(){return {type:"state",ok:true,configured:Boolean(API_KEY),scanning:scanInProgress,activeClients,lastScanAt,lastError,pollIntervalMs:POLL_INTERVAL_MS,state:{...state,threshold:dynamicThreshold},pairs:getPairs()};}
function sendJSON(ws,d){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(d));}
function broadcast(d){const msg=JSON.stringify(d);for(const c of wss.clients)if(c.readyState===WebSocket.OPEN)c.send(msg);}
function broadcastState(){broadcast(buildPayload());}
async function scanPair(symbol){
  if(!PAIRS.includes(symbol))throw new Error("ไม่รองรับคู่เงินนี้");
  try{
    const candles=await fetchCandles(symbol,200); if(candles.length<MIN_CANDLES)throw new Error(`ข้อมูลไม่เพียงพอ: ${candles.length} แท่ง`);
    const latest=candles.at(-1),a=analyzeCandles(candles);
    const p={symbol,name:symbol,timeframe:"1min",...a,price:latest.close,candleTime:new Date(latest.time).toISOString(),updatedAt:new Date().toISOString(),dataStatus:"LIVE_REFERENCE",source:"Twelve Data - reference market",candleCount:candles.length};
    pairsCache.set(symbol,p);lastError=null;if(state.symbol===symbol)Object.assign(state,p,{threshold:dynamicThreshold});
    broadcast({type:"pair_update",pair:p});return p;
  }catch(e){lastError=e.message;const p={...pairsCache.get(symbol),signal:"STANDBY",dataStatus:"ERROR",reason:e.message,updatedAt:new Date().toISOString()};pairsCache.set(symbol,p);if(state.symbol===symbol)Object.assign(state,p);broadcast({type:"pair_update",pair:p});return p;}
}
async function scanAllPairs(){
  if(scanInProgress)return {ok:false,message:"กำลังสแกนอยู่"};
  if(!API_KEY){lastError="ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY";broadcastState();return {ok:false,message:lastError};}
  scanInProgress=true;broadcast({type:"scan_status",scanning:true});
  try{
    const results=[];
    for(const symbol of PAIRS){results.push(await scanPair(symbol));await new Promise(r=>setTimeout(r,1200));}
    lastScanAt=new Date().toISOString();
    const best=results.filter(x=>x.signal!=="STANDBY").sort((a,b)=>b.score-a.score)[0];
    broadcast({type:"scan_complete",scanning:false,lastScanAt,pairs:getPairs(),bestPair:best?.symbol||null});
    return {ok:true,lastScanAt,bestPair:best?.symbol||null,results};
  }finally{scanInProgress=false;broadcast({type:"scan_status",scanning:false});broadcastState();}
}
async function runBacktest(symbol, outputsize=1000){
  if(!PAIRS.includes(symbol))throw new Error("ไม่รองรับคู่เงินนี้");
  const candles=await fetchCandles(symbol,outputsize);
  if(candles.length<MIN_CANDLES+2)throw new Error(`ข้อมูลย้อนหลังไม่พอ (${candles.length} แท่ง)`);
  const results=[];let skipped=0;
  for(let i=MIN_CANDLES-1;i<candles.length-1;i++){
    const window=candles.slice(0,i+1);
    const a=analyzeCandles(window,{backtest:true,referenceTime:window.at(-1).time});
    if(a.signal==="STANDBY"){skipped++;continue;}
    const entry=candles[i].close, exit=candles[i+1].close;
    const win=a.signal==="CALL"?exit>entry:exit<entry;
    const tie=exit===entry;
    results.push({time:new Date(candles[i].time).toISOString(),signal:a.signal,score:a.score,entry,exit,win:tie?null:win});
  }
  const decided=results.filter(r=>r.win!==null),wins=decided.filter(r=>r.win).length,losses=decided.length-wins;
  return {ok:true,symbol,interval:"1min",source:"Twelve Data reference candles",candles:candles.length,threshold:dynamicThreshold,
    method:"สัญญาณคำนวณจากข้อมูลถึงแท่งนั้นเท่านั้น; วัดผลด้วยการเปลี่ยนแปลง close ของแท่งถัดไป ไม่รวม payout/spread/slippage",
    totalSignals:results.length,skippedStandby:skipped,wins,losses,ties:results.length-decided.length,
    winRate:decided.length?round(wins/decided.length*100,2):null,signals:results.slice(-200)};
}

app.get("/api/health",(req,res)=>res.json({ok:true,configured:Boolean(API_KEY),activeClients,scanning:scanInProgress,lastScanAt,time:new Date().toISOString()}));
app.get("/api/status",(req,res)=>res.json(buildPayload()));
app.get("/api/pairs",(req,res)=>res.json({ok:true,pairs:getPairs()}));
app.post("/api/scan",async(req,res)=>{
  const now=Date.now();if(now-lastManualScanTime<5000)return res.status(429).json({ok:false,message:"กรุณารอสักครู่ก่อนสแกนใหม่"});lastManualScanTime=now;
  try{const symbol=(req.body&&req.body.symbol)||state.symbol;const pair=await scanPair(symbol);res.json({ok:true,pair,pairs:getPairs()});}catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post("/api/scan-all",async(req,res)=>{try{res.json(await scanAllPairs());}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post("/api/select",(req,res)=>{const symbol=req.body?.symbol;if(!PAIRS.includes(symbol))return res.status(400).json({ok:false,error:"คู่เงินไม่ถูกต้อง"});state.symbol=symbol;Object.assign(state,pairsCache.get(symbol),{symbol,timeframe:"1min",threshold:dynamicThreshold});broadcastState();res.json({ok:true,state:{...state}});});
app.post("/api/threshold",(req,res)=>{const n=Number(req.body?.threshold);if(!Number.isFinite(n)||n<40||n>95)return res.status(400).json({ok:false,error:"ตั้งค่าได้ระหว่าง 40–95"});dynamicThreshold=Math.round(n);state.threshold=dynamicThreshold;broadcastState();res.json({ok:true,threshold:dynamicThreshold});});
app.post("/api/backtest",async(req,res)=>{
  try{const symbol=req.body?.symbol||state.symbol;const outputsize=clamp(Number(req.body?.candles)||1000,200,5000);const result=await runBacktest(symbol,outputsize);res.json(result);}
  catch(e){res.status(400).json({ok:false,error:e.message});}
});

wss.on("connection",ws=>{
  activeClients++;sendJSON(ws,buildPayload());
  ws.on("message",async raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch{return sendJSON(ws,{type:"error",error:"รูปแบบข้อความไม่ถูกต้อง"});}
    const action=String(m.action||m.type||"").toLowerCase();
    if(["get_state","status"].includes(action))return sendJSON(ws,buildPayload());
    if(["set_symbol","select_pair"].includes(action)){if(!PAIRS.includes(m.symbol))return sendJSON(ws,{type:"error",error:"ไม่รองรับคู่เงินนี้"});state.symbol=m.symbol;Object.assign(state,pairsCache.get(m.symbol),{symbol:m.symbol,timeframe:"1min",threshold:dynamicThreshold});return broadcastState();}
    if(action==="set_threshold"){const n=Number(m.threshold);if(Number.isFinite(n)&&n>=40&&n<=95){dynamicThreshold=Math.round(n);state.threshold=dynamicThreshold;broadcastState();}return;}
    if(["manual_scan","scan","rescan"].includes(action)){try{sendJSON(ws,{type:"scan_result",...await scanPair(m.symbol||state.symbol)});}catch(e){sendJSON(ws,{type:"error",error:e.message});}}
  });
  ws.on("close",()=>{activeClients=Math.max(0,activeClients-1);});
});

function startScheduler(){if(scanTimer)clearInterval(scanTimer);scanTimer=setInterval(()=>{if(activeClients>0&&!scanInProgress&&API_KEY)scanAllPairs().catch(e=>{lastError=e.message;broadcastState();});},POLL_INTERVAL_MS);}
app.use((req,res)=>{if(req.method!=="GET")return res.status(404).json({ok:false,error:"ไม่พบ endpoint"});res.sendFile(path.join(__dirname,"public","index.html"),e=>{if(e&&!res.headersSent)res.status(404).send("AI Signal Radar is running.");});});
server.listen(PORT,"0.0.0.0",()=>{console.log(`AI Signal Radar listening on ${PORT}`);startScheduler();});
process.on("SIGTERM",()=>{if(scanTimer)clearInterval(scanTimer);server.close(()=>process.exit(0));});
