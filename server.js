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

let dynamicThreshold = 62;
let activeClients = 0, scanInProgress = false, scanTimer = null;
let lastScanAt = null, lastError = null, apiCreditsUsed = 28;

const PAIRS = ["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","NZD/USD","EUR/GBP"];
const pairsCache = new Map(PAIRS.map(symbol => [symbol, {
  symbol, name:symbol, signal:"STANDBY", score:0, confidence:0, price:null,
  candleTime:null, updatedAt:null, dataStatus:"WAITING", reason:"รอสแกนข้อมูล", indicators:{}
}]));

const state = {
  symbol:"EUR/USD", timeframe:"1min", signal:"STANDBY", score:0, confidence:0,
  price:null, candleTime:null, updatedAt:null, dataStatus:"WAITING",
  reason:"รอข้อมูลตลาด", indicators:{}, threshold:dynamicThreshold, apiUsed: apiCreditsUsed
};

app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname,"public")));

function mean(a){ return a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN; }
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

async function fetchCandles(symbol){
  if(!API_KEY) throw new Error("ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY");
  const url=new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol",symbol); url.searchParams.set("interval","1min");
  url.searchParams.set("outputsize","150"); url.searchParams.set("timezone","UTC");
  url.searchParams.set("apikey",API_KEY);

  apiCreditsUsed = (apiCreditsUsed + 1) % 800; // นับโควต้า API

  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
  let response;
  try{ response=await fetch(url,{signal:controller.signal}); }
  catch(e){ throw new Error("เชื่อมต่อ Twelve Data ไม่สำเร็จ"); }
  finally{ clearTimeout(timer); }

  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const body=await response.json();
  if(!Array.isArray(body.values)) throw new Error("รูปแบบข้อมูลผิดพลาด");

  return body.values.map(x=>({
    time: Date.parse(x.datetime.replace(" ","T")+"Z"),
    open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close)
  })).reverse();
}

function analyzeCandles(candles){
  const closes = candles.map(c=>c.close);
  const latest = candles[candles.length-1];
  const e5 = emaSeries(closes,5), e9 = emaSeries(closes,9), e21 = emaSeries(closes,21);
  const rsi = rsiSeries(closes,14);
  const rsiNow = rsi[rsi.length-1] || 50;

  let bull=0, bear=0;
  if(e5.at(-1) > e9.at(-1) && e9.at(-1) > e21.at(-1)) bull += 3;
  if(e5.at(-1) < e9.at(-1) && e9.at(-1) < e21.at(-1)) bear += 3;
  if(rsiNow >= 52) bull += 2;
  if(rsiNow <= 48) bear += 2;
  if(latest.close > latest.open) bull += 1;
  if(latest.close < latest.open) bear += 1;

  const total = bull + bear;
  const score = total ? Math.round(100 * Math.max(bull,bear) / total) : 0;

  let signal = "STANDBY";
  if(score >= dynamicThreshold){
    if(bull > bear && rsiNow < 70) signal = "CALL";
    if(bear > bull && rsiNow > 30) signal = "PUT";
  }

  return {
    signal, score,
    indicators: {
      rsi14: Math.round(rsiNow),
      bullishPoints: bull,
      bearishPoints: bear
    }
  };
}

async function scanPair(symbol){
  try{
    const candles = await fetchCandles(symbol);
    const latest = candles[candles.length-1];
    const analysis = analyzeCandles(candles);
    const payload = {
      symbol, signal: analysis.signal, score: analysis.score,
      price: latest.close, updatedAt: new Date().toISOString(),
      indicators: analysis.indicators, apiUsed: apiCreditsUsed
    };
    pairsCache.set(symbol, payload);
    if(state.symbol === symbol) Object.assign(state, payload);
    broadcast({ type: "pair_update", pair: payload });
    return payload;
  }catch(e){
    const failed = { symbol, signal: "STANDBY", price: null, error: e.message, apiUsed: apiCreditsUsed };
    pairsCache.set(symbol, failed);
    broadcast({ type: "pair_update", pair: failed });
    return failed;
  }
}

function buildPayload(){ return { type: "state", configured: Boolean(API_KEY), state: { ...state, apiUsed: apiCreditsUsed } }; }
function broadcast(d){ const msg=JSON.stringify(d); for(const c of wss.clients) if(c.readyState===1) c.send(msg); }

app.post("/api/scan", async (req,res) => {
  const symbol = req.body?.symbol || state.symbol;
  const result = await scanPair(symbol);
  res.json({ ok: true, pair: result });
});

app.post("/api/select", (req,res) => {
  const symbol = req.body?.symbol;
  if(PAIRS.includes(symbol)) state.symbol = symbol;
  broadcast(buildPayload());
  res.json({ ok: true });
});

wss.on("connection", ws => {
  activeClients++;
  ws.send(JSON.stringify(buildPayload()));
  ws.on("message", raw => {
    let m; try{ m=JSON.parse(raw); }catch(e){ return; }
    if(m.action === "get_state") ws.send(JSON.stringify(buildPayload()));
    if(m.action === "set_symbol" && PAIRS.includes(m.symbol)) {
      state.symbol = m.symbol;
      broadcast(buildPayload());
    }
  });
  ws.onclose = () => { activeClients = Math.max(0, activeClients - 1); };
});

app.use((req,res) => res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
