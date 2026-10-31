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
const marketStates = new Map();
function createMarketState(market, symbol) {
  return {
    market, source: "Android screen OCR", symbol, interval: "1min",
    price: null, candleTime: null, updatedAt: null, updatedAtMs: 0,
    currentCandle: null, candles: [], ema5: null, ema20: null, rsi14: null, atr14: null,
    candidate: "STANDBY", score: 0, reason: "รอภาพจากหน้าจอ Android",
    signal: null, lastSignalId: null, lastOcrText: "", error: null, framesReceived: 0
  };
}
function getMarketState(market, symbol) {
  const key = market + ":" + symbol;
  if (!marketStates.has(key)) marketStates.set(key, createMarketState(market, symbol));
  return marketStates.get(key);
}
const DEFAULT_STATE = getMarketState("MAIN", process.env.OCR_SYMBOL || "EUR/USD");
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
  if(candles.length<30){state.candidate="STANDBY";state.score=0;state.signal=null;state.reason="รอแท่ง 1 นาทีที่ปิดแล้วอย่างน้อย 30 แท่งเพื่อคำนวณ";return;}
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
  state.ema5=round(e5);state.ema20=round(e20);state.rsi14=round(r,2);state.atr14=round(a);
  ocrState.candidate=direction;ocrState.score=direction==="STANDBY"?0:75;ocrState.reason=reason;
  if(direction!=="STANDBY"){
    const id=String(candles[last].minute)+":EMA5-20:"+direction;
    if(id!==state.lastSignalId){ocrState.lastSignalId=id;ocrState.signal={id,direction,score:75,candleTime:candles[last].minute,reason};}
  } else {ocrState.signal=null;}
}
function addPrice(state, price, timestamp) {
  const date=new Date(timestamp||Date.now());
  const minute=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),date.getUTCHours(),date.getUTCMinutes());
  const minuteText=new Date(minute).toISOString();
  if(!state.currentCandle||state.currentCandle.minuteMs!==minute){
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
function publicOcrState(state){
  const age=state.updatedAtMs?Date.now()-state.updatedAtMs:Infinity;
  const fresh=age<=MAX_AGE_MS&&!state.error;
  return {
    market:state.market,source:state.source,symbol:state.symbol,interval:state.interval,
    price:fresh?state.price:null,updatedAt:state.updatedAt,dataAgeMs:Number.isFinite(age)?age:null,
    dataFresh:fresh,ema5:fresh?state.ema5:null,ema20:fresh?state.ema20:null,
    rsi14:fresh?state.rsi14:null,atr14:fresh?state.atr14:null,
    candidate:fresh?state.candidate:"STANDBY",score:fresh?state.score:0,
    reason:fresh?state.reason:(state.error||"รอภาพจากหน้าจอ Android"),
    signal:fresh?state.signal:null,candles:fresh?state.candles.slice(-60):[],
    currentCandle:fresh?state.currentCandle:null,framesReceived:state.framesReceived,
    ocrConfigured:Boolean(SCREEN_TOKEN),error:state.error
  };
}app.post("/api/ocr/frame",async(req,res)=>{
  if(!authorized(req))return res.status(401).json({ok:false,error:SCREEN_TOKEN?"SCREEN_INGEST_TOKEN ไม่ถูกต้อง":"ยังไม่ได้ตั้ง SCREEN_INGEST_TOKEN ใน Render"});
  let state=null;
  try{
    const market=String(req.body?.market||"").toUpperCase();
    const symbol=String(req.body?.symbol||"").toUpperCase().replace(/^([A-Z]{3})([A-Z]{3})$/,"$1/$2");
    if(!["MAIN","OTC"].includes(market))throw new Error("กรุณาเลือกตลาดหลักหรือ OTC ให้ชัดเจนก่อนส่งภาพ");
    if(!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol))throw new Error("ชื่อคู่เงินไม่ถูกต้อง");
    state=getMarketState(market,symbol);
    let price=Number(req.body?.price),ocrText="";
    if(!Number.isFinite(price)||price<=0){
      const recognized=await recognizeImage(req.body?.image);
      price=recognized.price;ocrText=recognized.text;
    }
    const textHasOtc=/\bOTC\b/i.test(ocrText);
    if(market==="MAIN"&&textHasOtc)throw new Error("ตรวจพบคำว่า OTC ในภาพ แต่เลือกตลาดหลักอยู่ ระบบจึงปฏิเสธเพื่อป้องกันข้อมูลปะปน");
    if(market==="OTC"&&!textHasOtc&&!req.body?.otcConfirmed)throw new Error("ภาพยังไม่พบคำว่า OTC กรุณาติ๊กยืนยันว่าเป็นกราฟ OTC ก่อนส่ง");
    const ts=Number(req.body?.timestamp)||Date.now();
    addPrice(state,price,ts);
    state.lastOcrText=ocrText;
    res.json({ok:true,market,symbol,price,ocrText:ocrText.slice(0,300),state:publicOcrState(state)});
  }catch(e){
    if(state){state.error=e.message;state.candidate="STANDBY";state.score=0;state.signal=null;}
    res.status(422).json({ok:false,error:e.message,state:state?publicOcrState(state):null});
  }
});
