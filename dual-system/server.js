"use strict";
const express=require("express"),path=require("path"),crypto=require("crypto");
const {createWorker}=require("tesseract.js");
const app=express();app.disable("x-powered-by");
app.use(express.json({limit:"8mb"}));
app.use(express.static(path.join(__dirname,"public"),{etag:false,maxAge:0}));
const PORT=Number(process.env.PORT)||10000;
const OLD_API_URL=(process.env.OLD_API_URL||"https://my-ai-signal-bot-v2.onrender.com").replace(/\/+$/,"");
const SCREEN_TOKEN=process.env.SCREEN_INGEST_TOKEN||"";
const MAX_FRAME_BYTES=5*1024*1024,MAX_AGE_MS=90000;
const states=new Map();let workerPromise=null;let latestAndroidOcr=null;const ocrRateLimits=new Map();
function stateFor(market,symbol){const key=market+":"+symbol;if(!states.has(key))states.set(key,{market,symbol,interval:"1min",price:null,updatedAt:null,updatedAtMs:0,currentCandle:null,candles:[],ema5:null,ema20:null,rsi14:null,atr14:null,candidate:"STANDBY",score:0,reason:"รอภาพจากหน้าจอ Android",signal:null,lastSignalId:null,lastOcrText:"",error:null,framesReceived:0});return states.get(key);}
function ema(v,p){if(v.length<p)return null;let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p,k=2/(p+1);for(let i=p;i<v.length;i++)x=v[i]*k+x*(1-k);return x;}
function rsi(v,p=14){if(v.length<=p)return null;let g=0,l=0;for(let i=1;i<=p;i++){let d=v[i]-v[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){let d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}if(al===0)return 100;if(ag===0)return 0;return 100-100/(1+ag/al);}
function atr(cs,p=14){if(cs.length<=p)return null;let tr=[];for(let i=1;i<cs.length;i++){let c=cs[i],q=cs[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-q.close),Math.abs(c.low-q.close)));}let x=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<tr.length;i++)x=(x*(p-1)+tr[i])/p;return x;}
function rnd(v,n=6){return Number.isFinite(v)?Number(v.toFixed(n)):null;}
function calc(s){const cs=s.candles,cl=cs.map(c=>c.close);if(cs.length<30){s.candidate="STANDBY";s.score=0;s.signal=null;s.reason="รอแท่ง 1 นาทีที่ปิดแล้วอย่างน้อย 30 แท่ง";return;}const e5s=[],e20s=[];for(let i=0;i<cl.length;i++){e5s.push(ema(cl.slice(0,i+1),5));e20s.push(ema(cl.slice(0,i+1),20));}const i=cl.length-1,e5=e5s[i],e20=e20s[i],r=rsi(cl),a=atr(cs),up=e5s[i-1]<=e20s[i-1]&&e5>e20,down=e5s[i-1]>=e20s[i-1]&&e5<e20,px=cl[i];let d="STANDBY",why="รอ EMA 5 ตัด EMA 20 บนแท่งที่ปิดแล้ว";if(!Number.isFinite(a)||px<=0||a/px<0.00002)why="ความผันผวนต่ำหรือข้อมูล ATR ยังไม่พอ";else if(up&&px>e5&&px>e20&&r>50){d="CALL";why="EMA 5 ตัดขึ้น EMA 20 และ RSI ยืนยันแรงซื้อ";}else if(down&&px<e5&&px<e20&&r<50){d="PUT";why="EMA 5 ตัดลง EMA 20 และ RSI ยืนยันแรงขาย";}s.ema5=rnd(e5);s.ema20=rnd(e20);s.rsi14=rnd(r,2);s.atr14=rnd(a);s.candidate=d;s.score=d==="STANDBY"?0:75;s.reason=why;if(d!=="STANDBY"){const id=s.market+":"+s.symbol+":"+cs[i].minute+":EMA5-20:"+d;if(id!==s.lastSignalId){s.lastSignalId=id;s.signal={id,direction:d,score:75,candleTime:cs[i].minute,reason:why,market:s.market,symbol:s.symbol};}}else s.signal=null;}
function addPrice(s,price,timestamp){const dt=new Date(timestamp||Date.now()),m=Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate(),dt.getUTCHours(),dt.getUTCMinutes()),mt=new Date(m).toISOString();if(!s.currentCandle||s.currentCandle.minuteMs!==m){if(s.currentCandle){const closed={...s.currentCandle};delete closed.minuteMs;s.candles.push(closed);s.candles=s.candles.slice(-300);calc(s);}s.currentCandle={minute:mt,minuteMs:m,open:price,high:price,low:price,close:price};}else{s.currentCandle.high=Math.max(s.currentCandle.high,price);s.currentCandle.low=Math.min(s.currentCandle.low,price);s.currentCandle.close=price;}s.price=price;s.updatedAt=new Date().toISOString();s.updatedAtMs=Date.now();s.framesReceived++;s.error=null;}
function publicState(s){const age=s.updatedAtMs?Date.now()-s.updatedAtMs:Infinity,fresh=age<=MAX_AGE_MS&&!s.error;return{market:s.market,symbol:s.symbol,interval:s.interval,price:fresh?s.price:null,updatedAt:s.updatedAt,dataAgeMs:Number.isFinite(age)?age:null,dataFresh:fresh,ema5:fresh?s.ema5:null,ema20:fresh?s.ema20:null,rsi14:fresh?s.rsi14:null,atr14:fresh?s.atr14:null,candidate:fresh?s.candidate:"STANDBY",score:fresh?s.score:0,reason:fresh?s.reason:(s.error||"รอภาพจากหน้าจอ Android"),signal:fresh?s.signal:null,candles:fresh?s.candles.slice(-60):[],currentCandle:fresh?s.currentCandle:null,framesReceived:s.framesReceived,ocrConfigured:Boolean(SCREEN_TOKEN),error:s.error};}
function authorized(req){if(!SCREEN_TOKEN)return false;const a=Buffer.from(String(req.get("x-screen-token")||"")),b=Buffer.from(SCREEN_TOKEN);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
async function recognizeImage(dataUrl,symbol){
 const b64=String(dataUrl||"").replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,"");
 if(!b64||b64.length>MAX_FRAME_BYTES*1.5)throw new Error("ภาพว่างหรือใหญ่เกิน 5 MB");
 const buf=Buffer.from(b64,"base64");if(buf.length>MAX_FRAME_BYTES)throw new Error("ภาพใหญ่เกิน 5 MB");
 if(!workerPromise)workerPromise=createWorker("eng");
 const w=await workerPromise;let text="";
 const extract=t=>[...String(t||"").matchAll(/\b\d{1,4}[.,]\d{3,6}\b/g)].map(x=>Number(x[0].replace(",","."))).filter(x=>Number.isFinite(x)&&x>0);
 let nums=[];
 try{
  await w.setParameters({tessedit_pageseg_mode:"11",tessedit_char_whitelist:""});
  let result=await w.recognize(buf);text=String(result.data.text||"");nums=extract(text);
  if(!nums.length){
   await w.setParameters({tessedit_pageseg_mode:"6",tessedit_char_whitelist:"0123456789.,"});
   result=await w.recognize(buf);text=String(result.data.text||"");nums=extract(text);
  }
 }finally{
  await w.setParameters({tessedit_pageseg_mode:"11",tessedit_char_whitelist:""});
 }
 const isJpy=/JPY/.test(symbol||"");
 const likely=nums.filter(x=>isJpy?(x>=50&&x<=3000):(x>=0.2&&x<=5));
 if(!likely.length)throw new Error("OCR อ่านราคาไม่ชัดหรือไม่ตรงรูปแบบคู่เงิน กรุณาขยายกราฟให้เห็นตัวเลขราคาชัด แล้วลองส่งใหม่");
 return{price:likely[likely.length-1],text:text.slice(0,1000),candidateCount:likely.length};
}

// Android ML Kit structured feed. Text and screenshots remain on-device.
app.post("/api/ocr/text",(req,res)=>{
 res.set("Cache-Control","no-store");
 const now=Date.now(),client=String(req.ip||"unknown"),last=ocrRateLimits.get(client)||0;
 if(now-last<2000)return res.status(429).json({ok:false,error:"ส่งข้อมูลถี่เกินไป"});
 ocrRateLimits.set(client,now);
 const b=req.body||{},symbol=String(b.symbol||"").trim().toUpperCase();
 if(!/^[A-Z]{3}\\/[A-Z]{3}$/.test(symbol))return res.status(400).json({ok:false,error:"รูปแบบคู่เงินไม่ถูกต้อง"});
 const candidates=Array.isArray(b.priceCandidates)?b.priceCandidates.map(Number).filter(v=>Number.isFinite(v)&&v>0&&v<100000).slice(0,8):[];
 if(!candidates.length)return res.status(422).json({ok:false,error:"ยังไม่พบตัวเลขราคาที่เข้าเกณฑ์"});
 const capturedAt=Number(b.capturedAt)||now;
 latestAndroidOcr={symbol,marketType:"UNCONFIRMED",priceCandidates:[...new Set(candidates)],countdown:typeof b.countdown==="string"?b.countdown:null,capturedAt,receivedAt:new Date(now).toISOString(),receivedAtMs:now,dataFresh:now-capturedAt>=-5000&&now-capturedAt<=15000};
 console.log("[ANDROID OCR] received",symbol,"candidates="+candidates.length);
 res.status(202).json({ok:true,received:true,dataFresh:latestAndroidOcr.dataFresh,priceCandidates:latestAndroidOcr.priceCandidates});
});
app.get("/api/ocr/android-status",(req,res)=>{
 res.set("Cache-Control","no-store");
 if(!latestAndroidOcr)return res.json({connected:false,data:null});
 const ageMs=Date.now()-latestAndroidOcr.receivedAtMs;
 res.json({connected:ageMs<=15000,ageMs,data:{...latestAndroidOcr,receivedAtMs:undefined,dataFresh:ageMs<=15000&&latestAndroidOcr.dataFresh}});
});
\napp.get("/api/health",(req,res)=>res.json({ok:true,service:"dual-system-mini-app",ocrConfigured:Boolean(SCREEN_TOKEN),workerReady:Boolean(workerPromise),framesReceived:[...states.values()].reduce((n,s)=>n+s.framesReceived,0),androidOcrConnected:Boolean(latestAndroidOcr&&Date.now()-latestAndroidOcr.receivedAtMs<=15000),lastFrameAt:[...states.values()].map(s=>s.updatedAt).filter(Boolean).sort().pop()||null,markets:["MAIN","OTC"],serverTime:Date.now()}));
app.get("/api/old/status",async(req,res)=>{try{const r=await fetch(OLD_API_URL+"/api/status",{signal:AbortSignal.timeout(10000),headers:{Accept:"application/json"}});res.status(r.status).set("Cache-Control","no-store").json(await r.json());}catch(e){res.status(502).json({dataFresh:false,candidate:"STANDBY",error:"เชื่อมต่อระบบเดิมไม่ได้: "+e.message});}});
app.get("/api/old/health",async(req,res)=>{try{const r=await fetch(OLD_API_URL+"/api/health",{signal:AbortSignal.timeout(10000)});res.status(r.status).json(await r.json());}catch(e){res.status(502).json({ok:false,error:e.message});}});
for(const action of ["start","stop","heartbeat"])app.post("/api/old/scan/"+action,async(req,res)=>{try{const r=await fetch(OLD_API_URL+"/api/scan/"+action,{method:"POST",signal:AbortSignal.timeout(25000),headers:{Accept:"application/json"}});res.status(r.status).json(await r.json());}catch(e){res.status(502).json({error:"ระบบเดิมไม่ตอบสนอง: "+e.message});}});
app.get("/api/new/status",(req,res)=>{const market=String(req.query.market||"MAIN").toUpperCase(),symbol=String(req.query.symbol||"EUR/USD").toUpperCase().replace(/^([A-Z]{3})([A-Z]{3})$/,"$1/$2");if(!["MAIN","OTC"].includes(market)||!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol))return res.status(400).json({error:"market หรือ symbol ไม่ถูกต้อง"});res.set("Cache-Control","no-store").json({...publicState(stateFor(market,symbol)),androidOcr:latestAndroidOcr?{...latestAndroidOcr,receivedAtMs:undefined,connected:Date.now()-latestAndroidOcr.receivedAtMs<=15000}:null});});
app.post("/api/ocr/frame",async(req,res)=>{if(!authorized(req))return res.status(401).json({ok:false,error:SCREEN_TOKEN?"SCREEN_INGEST_TOKEN ไม่ถูกต้อง":"ยังไม่ได้ตั้ง SCREEN_INGEST_TOKEN ใน Render"});let s=null;try{const market=String(req.body?.market||"").toUpperCase(),symbol=String(req.body?.symbol||"").toUpperCase().replace(/^([A-Z]{3})([A-Z]{3})$/,"$1/$2");if(!["MAIN","OTC"].includes(market))throw new Error("กรุณาเลือกตลาดหลักหรือ OTC ก่อนส่งภาพ");if(!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol))throw new Error("ชื่อคู่เงินไม่ถูกต้อง");s=stateFor(market,symbol);let price=Number(req.body?.price),ocrText="";if(!Number.isFinite(price)||price<=0){const o=await recognizeImage(req.body?.image,symbol);price=o.price;ocrText=o.text;}const hasOtc=/\bOTC\b/i.test(ocrText);if(market==="MAIN"&&hasOtc)throw new Error("ภาพมีคำว่า OTC แต่เลือกตลาดหลัก ระบบปฏิเสธเพื่อป้องกันข้อมูลปะปน");if(market==="OTC"&&!hasOtc&&!req.body?.otcConfirmed)throw new Error("ไม่พบคำว่า OTC ในภาพ กรุณาติ๊กยืนยันว่าเป็นกราฟ OTC ก่อนส่ง");addPrice(s,price,Number(req.body?.timestamp)||Date.now());s.lastOcrText=ocrText;console.log("[OCR] frame accepted",market,symbol,"price="+price,"frames="+s.framesReceived);res.json({ok:true,market,symbol,price,ocrText:ocrText.slice(0,300),state:publicState(s)});}catch(e){if(s){s.error=e.message;s.candidate="STANDBY";s.score=0;s.signal=null;}console.warn("[OCR] frame rejected",String(req.body?.market||"?"),String(req.body?.symbol||"?"),e.message);res.status(422).json({ok:false,error:e.message,state:s?publicState(s):null});}});
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log("Dual System Mini App listening on "+PORT));
process.on("SIGTERM",async()=>{try{if(workerPromise){const w=await workerPromise;await w.terminate();}}catch(e){}process.exit(0);});
