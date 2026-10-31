# CONTINUE HERE — AI SIGNAL RADAR OCR

อัปเดตบริบท: 31 ตุลาคม 2026 (รอบแก้ไขล่าสุด)

## เป้าหมายของผู้ใช้
พัฒนา AI SIGNAL RADAR OCR ให้ใช้งานบน Android เพื่ออ่านข้อมูลจากกราฟที่เปิดอยู่บนหน้าจอ (เช่น 8xTrade / IQ Option) แล้วส่งข้อมูลราคาและคู่เงินให้ backend วิเคราะห์ ผู้ใช้เป็นผู้กดซื้อขายเอง ระบบไม่ควรล็อกอินบัญชีโบรกเกอร์หรือส่งคำสั่งซื้อขายอัตโนมัติ

## Repository
- https://github.com/0953922631n5566-ctrl/my-ai-signal-bot
- Default branch: main
- Repository เป็น Public
- มีสิทธิ์ push ผ่าน GitHub integration ในการสนทนาที่เชื่อมต่อบัญชีแล้ว

## ภาพอ้างอิง
- ภาพที่พบใน repo: `Screenshot_2026-10-31-10-26-00-457_com.android.chrome.jpg`
- URL: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/blob/main/Screenshot_2026-10-31-10-26-00-457_com.android.chrome.jpg
- ภาพอ้างอิงที่ 2 ที่ผู้ใช้กล่าวถึงยังไม่พบใน repository หรือไฟล์ที่เข้าถึงได้ จึงยังไม่ได้อัปโหลด ห้ามสร้างภาพปลอม/ใช้ภาพ mockup แทนต้นฉบับ
- หากต้องการเพิ่มภาพที่ 2 ให้ใช้ไฟล์ต้นฉบับภาพนั้นเท่านั้น

## สถานะโค้ดที่ตรวจพบ
- Backend: `server.js`
- Dashboard: `public/index.html`, `public/app.js`, `public/styles.css`
- Android project: `android-ocr-apk/`
- Android OCR ใช้ MediaProjection และ on-device ML Kit text recognition
- Workflow: `.github/workflows/build-android-ocr.yml`
- Render config: `render.yaml`
- Commit `18f397570e8ef4e7697c659b9e9200d6b408d717` — ตั้ง market type เป็น `UNCONFIRMED` หาก OCR ยังไม่ยืนยัน
- Commit `badb9344d034fc4efc23e4fa31de9dadfa180984` — แก้ Android OCR ให้ POST ไป `https://my-ai-signal-bot-v2.onrender.com/api/ocr` ซึ่งตรงกับ route ใน backend repository นี้ (เดิมส่งไปคนละ Render service และ path `/api/ocr/text`)
- Commit `d28bbdea70df89f1bbbe86446568593467b0ddd3` — backend เก็บ `UNCONFIRMED` ไว้ตามจริง แทนการแปลงเป็น `DIGITAL_OR_UNKNOWN`
- การแก้ endpoint เป็นการแก้ความผิดพลาดที่ตรวจพบจาก source code; ยังต้องรอ GitHub Actions build APK และทดสอบรับข้อมูลบน Render/Android จริงก่อนยืนยันว่าทำงานครบ

## ข้อกำหนดที่ต้องรักษา
1. อ่านทั้งราคา คู่เงิน และเวลาจากหน้าจอ ไม่ใช่จับเวลาอย่างเดียว
2. แยกข้อมูลที่ OCR อ่านได้จริงออกจากค่าที่ระบบคำนวณ ห้ามเติมราคาหรือเดาตลาดเอง
3. เมื่ออ่านข้อมูลไม่ครบหรือไม่มั่นใจ ให้แสดง WAIT / STANDBY และเหตุผล ไม่ส่ง CALL/PUT ที่ไม่มีข้อมูลรองรับ
4. ห้ามส่งคำสั่งซื้อขายอัตโนมัติ ผู้ใช้เป็นผู้ตัดสินใจเอง
5. ห้ามใส่ API key, token, รหัสผ่าน, ข้อมูลบัญชี หรือ secrets ลงใน GitHub
6. ต้องทดสอบกับภาพหน้าจอจริงหลายกรณี รวมถึงภาพที่อ่านไม่ชัด ก่อนเรียกว่าใช้งานจริง
7. ไม่มีการรับประกัน win rate หรือจำนวนไม้ชนะ

## บันทึกการทำงานรอบล่าสุด
- Commit `1eef60f0ff72fee7a2d0af425c976991afc81545` — harden `POST /api/ocr`: บังคับ capturedAt ต้องเป็นเวลาปัจจุบัน (ไม่เกิน 5 วินาทีในอนาคต/ไม่เก่ากว่า 15 วินาที), ตรวจรูปแบบ countdown, ย้าย rate limit หลังตรวจ symbol/time และส่งสถานะ `priceConfirmed:false`, `analysisLinked:false` ชัดเจน
- Commit `873395ee9a7889be6a6ff308cde29c12a9ec5023` — ปรับหน้า Dashboard ให้ระบุชัดว่า OCR feed ยังไม่เชื่อมกับการคำนวณ CALL/PUT ไม่ทำให้ผู้ใช้เข้าใจผิดว่าราคาจาก OCR ถูกใช้สร้างสัญญาณแล้ว
- ตรวจโค้ดจริงพบว่า `server.js` คำนวณสัญญาณจาก Twelve Data ตาม `FOREX_PAIR` เท่านั้น ส่วน OCR เป็น feed แยกที่เก็บ symbol/priceCandidates/countdown ไว้ในหน่วยความจำ; ยังไม่มี logic จับคู่ราคา OCR กับราคาตลาดหรือใช้ OCR เป็น input ของ signal engine
- `CaptureService.kt` ยังดึงตัวเลขราคาเป็น candidate หลายค่าและใช้ regex คู่เงินตัวแรกที่พบจากข้อความ OCR ทั้งหน้าจอ จึงยังยืนยันไม่ได้ว่าเป็นคู่เงิน/ราคาของกราฟที่กำลังเลือกจริง
- สถานะ Build APK: ยังไม่ได้ตรวจผล GitHub Actions run ล่าสุดในรอบนี้; ห้ามอ้างว่า APK build ผ่านหรือพร้อมติดตั้งจนกว่าจะมีผล run/artifact และทดสอบบน Android จริง

## ขั้นตอนต่อไป
1. ตรวจ GitHub Actions ว่ามี build APK หลังการแก้ไขล่าสุดหรือไม่ และดาวน์โหลด artifact เฉพาะเมื่อ workflow สำเร็จ
2. ติดตั้ง APK ที่ build ใหม่ แล้วตรวจ `/api/ocr/status` ว่า backend รับ symbol, priceCandidates, countdown และ capturedAt จริงหรือไม่; ทดสอบ payload เก่า/เวลาอนาคตว่าถูกปฏิเสธ
3. ตรวจว่าหน้า dashboard แสดงคู่เงิน/ราคาที่ OCR พบตรงกับหน้าจอจริงหรือไม่; ปัจจุบันส่งเป็น priceCandidates หลายค่า ไม่ได้เลือกค่าราคาเดียวโดยอัตโนมัติ และ feed นี้ยังไม่ถูกใช้สร้างสัญญาณ
4. ทดสอบกรณีราคาไม่ครบ / คู่เงินไม่ชัด / marketType เป็น UNCONFIRMED
5. เพิ่มภาพอ้างอิงที่ 2 เมื่อมีไฟล์ต้นฉบับให้เข้าถึง
6. Build APK ผ่าน GitHub Actions และติดตั้งทดสอบบน Android จริง

เอกสารนี้เป็นบริบทสำหรับการทำงานต่อ ไม่ใช่หลักฐานว่าระบบผ่านการทดสอบใช้งานจริงแล้ว
