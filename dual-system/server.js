"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createWorker } = require("tesseract.js");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

const PORT = Number(process.env.PORT) || 10000;
const OLD_API_URL = (process.env.OLD_API_URL || "https://my-ai-signal-bot-v2.onrender.com").replace(/\/+$/, "");
const SCREEN_TOKEN = process.env.SCREEN_INGEST_TOKEN || "";
const MAX_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_AGE_MS = 90000;
const EMA_PERIODS = [5, 20];
const ocrState = {
  source: "Android screen OCR",
  symbol: process.env.OCR_SYMBOL || "EUR/USD",
  interval: "1min",
  price: null, candleTime: null, updatedAt: null, updatedAtMs: 0,
  currentCandle: null, candles: [], ema5: null, ema20: null, rsi14: null, atr14: null,
  candidate: "STANDBY", score: 0, reason: "รอภาพจากหน้าจอ Android",
  signal: null, lastSignalId: null, lastOcrText: "", error: null, framesReceived: 0
};
let workerPromise = null;

function ema(values, period) {
  if (values.length < period) return null;
  let v = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) v = values[i] * k + v * (1-k);
  return v;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain=0, loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(d,0);loss+=Math.max(-d,0);}
  let ag=gain/period, al=loss/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);
}
function atr(candles, period=14) {
  if(candles.length<=period)return null;
  const tr=[];
  for(let i=1;i<candles.length;i++){const c=candles[i],p=candles[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}
  let v=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)v=(v*(period-1)+tr[i])/period;
  return v;
}
function round(v,n=6){return Number.isFinite(v)?Number(v.toFixed(n)):null;}
function calculateSignal() {
  const candles=ocrState.candles, closes=candles.map(c=>c.close);
  if(candles.length<30){ocrState.candidate="STANDBY";ocrState.score=0;ocrState.signal=null;ocrState.reason="รอแท่ง 1 นาทีที่ปิดแล้วอย่างน้อย 30 แท่งเพื่อคำนวณ";return;}
  const ema5Series=[],ema20Series=[];
  for(let i=0;i<closes.length;i++){ema5Series.push(ema(closes.slice(0,i+1),5));ema20Series.push(ema(closes.slice(0,i+1),20));}
  const last=closes.length-1,prev=last-1;
  const e5=ema5Series[last],e20=ema20Series[last],r=rsi(closes,14),a=atr(candles,14);
  const crossUp=ema5Series[prev]!==null&&ema20Series[prev]!==null&&ema5Series[prev]<=ema20Series[prev]&&e5>e20;
  const crossDown=ema5Series[prev]!==null&&ema20Series[prev]!==null&&ema5Series[prev]>=ema20Series[prev]&&e5<e20;
  let direction="STANDBY",reason="รอ EMA 5 ตัด EMA 20 บนแท่งที่ปิดแล้ว";
  const px=closes[last],volatility=Number.isFinite(a)&&px>0&&a/px>=0.00002;
  if(!volatility)reason="ความผันผวนต่ำหรือข้อมูล ATR ยังไม่พอ";
  else if(crossUp&&px>e5&&px>e20&&r>50){direction="CALL";reason="EMA 5 ตัดขึ้น EMA 20 และ RSI ยืนยันแรงซื้อ";}
  else if(crossDown&&px<e5&&px<e20&&r<50){direction="PUT";reason="EMA 5 ตัดลง EMA 20 และ RSI ยืนยันแรงขาย";}
  ocrState.ema5=round(e5);ocrState.ema20=round(e20);ocrState.rsi14=round(r,2);ocrState.atr14=round(a);
  ocrState.candidate=direction;ocrState.score=direction==="STANDBY"?0:75;ocrState.reason=reason;
  if(direction!=="STANDBY"){
    const id=String(candles[last].minute)+":EMA5-20:"+direction;
    if(id!==ocrState.lastSignalId){ocrState.lastSignalId=id;ocrState.signal={id,direction,score:75,candleTime:candles[last].minute,reason};}
  } else {ocrState.signal=null;}
}
function addPrice(price, timestamp) {
  const date=new Date(timestamp||Date.now());
  const minute=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),date.getUTCHours(),date.getUTCMinutes());
  const minuteText=new Date(minute).toISOString();
  if(!ocrState.currentCandle||ocrState.currentCandle.minuteMs!==minute){
    if(ocrState.currentCandle){
      const closed={...ocrState.currentCandle};delete closed.minuteMs;
      ocrState.candles.push(closed);ocrState.candles=ocrState.candles.slice(-300);
      calculateSignal();
    }
    ocrState.currentCandle={minute:minuteText,minuteMs:minute,open:price,high:price,low:price,close:price};
  } else {
    ocrState.currentCandle.high=Math.max(ocrState.currentCandle.high,price);
    ocrState.currentCandle.low=Math.min(ocrState.currentCandle.low,price);
    ocrState.currentCandle.close=price;
  }
  ocrState.price=price;ocrState.updatedAt=new Date().toISOString();ocrState.updatedAtMs=Date.now();
  ocrState.candleTime=minuteText;ocrState.framesReceived++;ocrState.error=null;
}
function publicOcrState(){
  const age=ocrState.updatedAtMs?Date.now()-ocrState.updatedAtMs:Infinity;
  const fresh=age<=MAX_AGE_MS&&!ocrState.error;
  return {
    source:ocrState.source,symbol:ocrState.symbol,interval:ocrState.interval,
    price:fresh?ocrState.price:null,updatedAt:ocrState.updatedAt,dataAgeMs:Number.isFinite(age)?age:null,
    dataFresh:fresh,ema5:fresh?ocrState.ema5:null,ema20:fresh?ocrState.ema20:null,
    rsi14:fresh?ocrState.rsi14:null,atr14:fresh?ocrState.atr14:null,
    candidate:fresh?ocrState.candidate:"STANDBY",score:fresh?ocrState.score:0,
    reason:fresh?ocrState.reason:(ocrState.error||"รอภาพจากหน้าจอ Android"),
    signal:fresh?ocrState.signal:null,candles:fresh?ocrState.candles.slice(-60):[],
    currentCandle:fresh?ocrState.currentCandle:null,framesReceived:ocrState.framesReceived,
    ocrConfigured:Boolean(SCREEN_TOKEN),error:ocrState.error
  };
}
function authorized(req){
  if(!SCREEN_TOKEN)return false;
  const supplied=String(req.get("x-screen-token")||"");
  const a=Buffer.from(supplied),b=Buffer.from(SCREEN_TOKEN);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
async function recognizeImage(dataUrl){
  const base64=String(dataUrl||"").replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,"");
  if(!base64||base64.length>MAX_FRAME_BYTES*1.5)throw new Error("ภาพว่างหรือมีขนาดใหญ่เกิน 5 MB");
  const buffer=Buffer.from(base64,"base64");
  if(buffer.length>MAX_FRAME_BYTES)throw new Error("ภาพมีขนาดใหญ่เกิน 5 MB");
  if(!workerPromise)workerPromise=createWorker("eng");
  const worker=await workerPromise;
  const result=await worker.recognize(buffer);
  const text=String(result.data.text||"");
  ocrState.lastOcrText=text.slice(0,1000);
  const matches=[...text.matchAll(/\b\d{1,4}[.,]\d{3,6}\b/g)].map(m=>Number(m[0].replace(",","."))).filter(v=>Number.isFinite(v)&&v>0);
  if(!matches.length)throw new Error("อ่านข้อความราคาไม่พบ กรุณาส่งภาพที่เห็นตัวเลขราคาให้ชัด");
  // Prefer a likely FX quote: 0.x–2.x for most majors, but allow JPY and other pairs.
  const preferred=matches.filter(v=>v>=0.2&&v<=3);
  return preferred.length?preferred[preferred.length-1]:matches[matches.length-1];
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"dual-system-mini-app",oldApiUrl:OLD_API_URL,ocrConfigured:Boolean(SCREEN_TOKEN),serverTime:Date.now()}));
app.get("/api/old/status",async(req,res)=>{
  try{const r=await fetch(OLD_API_URL+"/api/status",{signal:AbortSignal.timeout(10000),headers:{Accept:"application/json"}});const d=await r.json();res.status(r.status).set("Cache-Control","no-store").json(d);}
  catch(e){res.status(502).json({dataFresh:false,candidate:"STANDBY",error:"เชื่อมต่อระบบเดิมไม่ได้: "+e.message});}
});
app.get("/api/old/health",async(req,res)=>{
  try{const r=await fetch(OLD_API_URL+"/api/health",{signal:AbortSignal.timeout(10000)});res.status(r.status).json(await r.json());}
  catch(e){res.status(502).json({ok:false,error:e.message});}
});
for(const action of ["start","stop","heartbeat"]){
  app.post("/api/old/scan/"+action,async(req,res)=>{
    try{const r=await fetch(OLD_API_URL+"/api/scan/"+action,{method:"POST",signal:AbortSignal.timeout(25000),headers:{Accept:"application/json"}});res.status(r.status).json(await r.json());}
    catch(e){res.status(502).json({error:"ระบบเดิมไม่ตอบสนอง: "+e.message});}
  });
}
app.get("/api/new/status",(req,res)=>{res.set("Cache-Control","no-store");res.json(publicOcrState());});
app.post("/api/ocr/frame",async(req,res)=>{
  if(!authorized(req))return res.status(401).json({ok:false,error:SCREEN_TOKEN?"SCREEN_INGEST_TOKEN ไม่ถูกต้อง":"ยังไม่ได้ตั้ง SCREEN_INGEST_TOKEN ใน Render"});
  try{
    let price=Number(req.body?.price);
    let ocrText="";
    if(!Number.isFinite(price)||price<=0){
      price=await recognizeImage(req.body?.image);
      ocrText=ocrState.lastOcrText;
    }
    const symbol=String(req.body?.symbol||ocrState.symbol).slice(0,20);
    if(!/^[A-Z]{3}\/?[A-Z]{3}$/i.test(symbol))throw new Error("ชื่อคู่เงินไม่ถูกต้อง");
    ocrState.symbol=symbol.toUpperCase().replace(/^([A-Z]{3})([A-Z]{3})$/,"$1/$2");
    addPrice(price,Number(req.body?.timestamp)||Date.now());
    res.json({ok:true,price,symbol:ocrState.symbol,ocrText:ocrText.slice(0,300),state:publicOcrState()});
  }catch(e){ocrState.error=e.message;ocrState.candidate="STANDBY";ocrState.score=0;ocrState.signal=null;res.status(422).json({ok:false,error:e.message,state:publicOcrState()});}
});
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("Dual System Mini App listening on "+PORT));
process.on("SIGTERM",async()=>{try{if(workerPromise){const w=await workerPromise;await w.terminate();}}catch(e){}process.exit(0);});
