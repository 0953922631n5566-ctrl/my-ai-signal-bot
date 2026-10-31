"use strict";
const $=id=>document.getElementById(id);
const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();}
let mode="old",oldData=null,newData=null,oldSignalId=null,newSignalId=null,stream=null,videoTimer=null,scan=false,sendingFrame=false;
const api=async(url,opts={})=>{const r=await fetch(url,{cache:"no-store",...opts});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"HTTP "+r.status);return d;};
const market=()=> $("marketSelect").value;
const symbol=()=> $("symbolSelect").value;
const marketQuery=()=>"?market="+encodeURIComponent(market())+"&symbol="+encodeURIComponent(symbol());
function directionClass(d){return d==="CALL"?"call":d==="PUT"?"put":"standby";}
function renderSingle(d,label){const dir=d?.candidate||"STANDBY";$("singleCard").className="signal "+directionClass(dir);$("singleDirection").textContent=dir;$("singleReason").textContent=d?.reason||"รอข้อมูล";$("singlePrice").textContent=d?.price??"--";$("singleScore").textContent=d?.score?d.score+"%":"--";$("singleRsi").textContent=d?.rsi14??"--";$("modeLabel").textContent=label;}
function renderCompare(){const od=oldData||{},nd=newData||{};$("oldDir").textContent=od.candidate||"STANDBY";$("oldDir").className=directionClass(od.candidate);$("oldReason").textContent=od.reason||od.error||"รอข้อมูล";$("oldPrice").textContent="ราคา "+(od.price??"--");$("newDir").textContent=nd.candidate||"STANDBY";$("newDir").className=directionClass(nd.candidate);$("newReason").textContent=nd.reason||"รอภาพ";$("newPrice").textContent="ราคา "+(nd.price??"--");}
function selectMode(next){mode=next;document.querySelectorAll(".switch button").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));$("singleCard").classList.toggle("hidden",mode==="compare");$("compareCards").classList.toggle("hidden",mode!=="compare");$("ocrPanel").classList.toggle("hidden",mode==="old");if(mode==="old")renderSingle(oldData,"กำลังใช้งานระบบเดิม");if(mode==="new")renderSingle(newData,"ระบบ OCR · "+(market()==="OTC"?"OTC":"ตลาดหลัก"));if(mode==="compare")renderCompare();$("startBtn").textContent=mode==="old"?(scan?"หยุดเฝ้าระวัง":"เริ่มเฝ้าระวัง"):(stream?"หยุดแชร์หน้าจอ":"เริ่มแชร์หน้าจอ");}
async function refresh(){try{const [o,n,h]=await Promise.allSettled([api("/api/old/status"),api("/api/new/status"+marketQuery()),api("/api/health")]);oldData=o.status==="fulfilled"?o.value:{candidate:"STANDBY",error:o.reason.message};newData=n.status==="fulfilled"?n.value:{candidate:"STANDBY",error:n.reason.message};$("oldStatus").textContent=oldData.dataFresh?"เชื่อมต่อ":"รอข้อมูล";$("newStatus").textContent=newData.dataFresh?"ได้รับราคาแล้ว":(newData.ocrConfigured?"รอภาพ":"ยังไม่ตั้ง Token");$("apiStatus").textContent=h.status==="fulfilled"?"บริการใหม่ออนไลน์":"บริการขัดข้อง";$("connection").textContent=h.status==="fulfilled"?"ONLINE":"OFFLINE";if(mode==="compare")renderCompare();else if(mode==="old")renderSingle(oldData,"กำลังใช้งานระบบเดิม");else renderSingle(newData,"OCR · "+(market()==="OTC"?"OTC":"ตลาดหลัก"));if(oldData.aiSignal?.id&&oldData.aiSignal.id!==oldSignalId){oldSignalId=oldData.aiSignal.id;if(mode==="old"||mode==="compare")notifySignal(oldData.aiSignal);}if(newData.signal?.id&&newData.signal.id!==newSignalId){newSignalId=newData.signal.id;if(mode==="new"||mode==="compare")notifySignal(newData.signal);}if(!newData.ocrConfigured)$("ocrState").textContent="ยังไม่ได้ตั้ง SCREEN_INGEST_TOKEN ใน Render";}catch(e){$("apiStatus").textContent=e.message;}}
function notifySignal(s){if(navigator.vibrate)navigator.vibrate([150,70,150]);if("Notification"in window&&Notification.permission==="granted")new Notification("AI Signal Radar · "+s.direction,{body:(s.market||"")+" "+(s.symbol||"")+" · "+(s.reason||"สัญญาณใหม่")});}
async function startOld(){await api("/api/old/scan/start",{method:"POST"});scan=true;$("startBtn").textContent="หยุดเฝ้าระวัง";await refresh();}
async function stopOld(){await api("/api/old/scan/stop",{method:"POST"});scan=false;$("startBtn").textContent="เริ่มเฝ้าระวัง";await refresh();}
async function sendFrame(dataUrl){
 const token=$("screenToken").value.trim()||sessionStorage.getItem("screenToken")||"";
 if(!token){$("ocrState").textContent="กรุณาใส่ SCREEN_INGEST_TOKEN ก่อนส่งภาพ";return;}
 if(sendingFrame)return;
 sendingFrame=true;
 const m=market(),sym=symbol(),otcConfirmed=$("otcConfirm").checked;
 sessionStorage.setItem("screenToken",token);
 try{
  const d=await api("/api/ocr/frame",{method:"POST",headers:{"Content-Type":"application/json","x-screen-token":token},body:JSON.stringify({image:dataUrl,market:m,symbol:sym,otcConfirmed})});
  newData=d.state;$("ocrState").textContent="รับราคา "+d.price+" · "+(m==="OTC"?"OTC":"ตลาดหลัก")+" · "+sym+" · ส่งสำเร็จ";
  if(mode!=="compare")renderSingle(newData,"OCR · "+m+" · "+sym);
 }catch(e){$("ocrState").textContent="OCR ไม่ผ่าน: "+e.message;}
 finally{sendingFrame=false;}
}
function chooseScreenshot(message="กรุณาเลือกรูปภาพหน้าจอกราฟจากโทรศัพท์"){$("ocrState").textContent=message;$("imageFile").click();}\nasync function capture(){if(!navigator.mediaDevices?.getDisplayMedia){chooseScreenshot("เบราว์เซอร์นี้ไม่รองรับแชร์หน้าจอ · กรุณาเลือกรูปภาพกราฟแทน");return;}try{stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});const v=$("screenVideo");v.srcObject=stream;await v.play();$("ocrState").textContent="กำลังอ่านภาพ · "+market()+" · "+symbol();videoTimer=setInterval(()=>{if(!v.videoWidth)return;const c=document.createElement("canvas");c.width=Math.min(v.videoWidth,1600);c.height=Math.round(v.videoHeight*c.width/v.videoWidth);c.getContext("2d").drawImage(v,0,0,c.width,c.height);sendFrame(c.toDataURL("image/jpeg",.9));},5000);stream.getVideoTracks()[0].addEventListener("ended",stopCapture);$("startBtn").textContent="หยุดแชร์หน้าจอ";}catch(e){chooseScreenshot("แชร์หน้าจอไม่ได้ ("+e.message+") · ใช้เลือกรูปภาพกราฟแทน");}}
function stopCapture(){if(videoTimer)clearInterval(videoTimer);videoTimer=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$("startBtn").textContent="เริ่มแชร์หน้าจอ";$("ocrState").textContent="หยุดแชร์หน้าจอแล้ว";}
function marketChanged(){$("otcConfirmRow").classList.toggle("hidden",market()!=="OTC");$("otcConfirm").checked=false;newSignalId=null;refresh();}
document.querySelectorAll(".switch button").forEach(b=>b.addEventListener("click",()=>selectMode(b.dataset.mode)));
$("startBtn").addEventListener("click",async()=>{try{if(mode==="old"){if(scan)await stopOld();else await startOld();}else if(stream)stopCapture();else await capture();}catch(e){$("ocrState").textContent=e.message;}});
$("captureBtn").addEventListener("click",capture);
$("imageFile").addEventListener("change",e=>{const f=e.target.files?.[0];if(!f)return;if(!f.type.startsWith("image/")){$("ocrState").textContent="ไฟล์นี้ไม่ใช่รูปภาพ กรุณาเลือกรูปภาพกราฟ";e.target.value="";return;}const reader=new FileReader();reader.onload=()=>{if(typeof reader.result==="string")sendFrame(reader.result);else $("ocrState").textContent="อ่านไฟล์ภาพไม่สำเร็จ กรุณาลองใหม่";};reader.onerror=()=>$("ocrState").textContent="เปิดรูปภาพไม่สำเร็จ กรุณาเลือกรูปใหม่";reader.readAsDataURL(f);e.target.value="";});
$("marketSelect").addEventListener("change",marketChanged);$("symbolSelect").addEventListener("change",()=>{newSignalId=null;refresh();});
const savedToken=sessionStorage.getItem("screenToken")||"";if(savedToken)$("screenToken").value=savedToken;$("screenToken").addEventListener("input",()=>$("screenToken").value.trim()?sessionStorage.setItem("screenToken",$("screenToken").value.trim()):sessionStorage.removeItem("screenToken"));
if("Notification"in window&&Notification.permission==="default")Notification.requestPermission().catch(()=>{});
marketChanged();selectMode("old");refresh();setInterval(refresh,5000);setInterval(()=>{if(scan)api("/api/old/scan/heartbeat",{method:"POST"}).catch(()=>{});},20000);
