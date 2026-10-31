# CONTINUE HERE — AI SIGNAL RADAR OCR

อัปเดตบริบท: 31 ตุลาคม 2026

## สถานะ APK ล่าสุด — ตรวจสอบ GitHub Actions แล้ว
- Branch ที่ตรวจ: `dual-system-independent`
- Workflow: `Build Android capture APK`
- Run ล่าสุด: #5, run ID `41159652560`
- Commit: `4c733a48b747ef6ce61e93f845b1d52e8e9fae40` — `Finalize saved settings label for Android capture 1.0.1`
- GitHub Actions conclusion: `success` (เสร็จ 31 ต.ค. 2026 เวลา 02:23:18 UTC)
- Artifact: `ai-signal-radar-capture-debug`, artifact ID `13026502179`, ZIP 819,149 bytes, ยังไม่หมดอายุ (หมดอายุ 29 ม.ค. 2027)
- ภายใน ZIP มี `app-debug.apk` ขนาด 826,149 bytes
- SHA-256 ของ artifact ZIP: `e73dfec194713d5ed96abf09298e5b4f2c0dd1c926b0e9c947925bfa642fd444`
- ไฟล์นี้เป็น **Debug APK** ไม่ใช่ signed Release APK; build ผ่านแต่ยังไม่ได้ติดตั้ง/ทดสอบบน Android เครื่องจริง จึงยืนยันได้เฉพาะว่ามีไฟล์ APK ดาวน์โหลดได้ ไม่ใช่ยืนยันว่าการอ่าน OCR และการส่งข้อมูลทำงานครบ
- Workflow run: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41159652560
- Actions list: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions

## เป้าหมายของผู้ใช้
พัฒนา AI SIGNAL RADAR OCR ให้ใช้งานบน Android เพื่ออ่านข้อมูลจากกราฟที่เปิดอยู่บนหน้าจอ (เช่น 8xTrade / IQ Option) แล้วส่งข้อมูลราคาและคู่เงินให้ backend วิเคราะห์ ผู้ใช้เป็นผู้กดซื้อขายเอง ระบบไม่ควรล็อกอินบัญชีโบรกเกอร์หรือส่งคำสั่งซื้อขายอัตโนมัติ

## Repository และ Branch
- Repository: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot
- เอกสารส่งต่องานนี้อยู่บน branch `main`
- Android build ที่ตรวจล่าสุดอยู่บน branch `dual-system-independent`

## ภาพอ้างอิง
- ภาพที่พบใน repo: `Screenshot_2026-10-31-10-26-00-457_com.android.chrome.jpg`
- ภาพอ้างอิงที่ 2 ที่ผู้ใช้กล่าวถึงยังไม่พบใน repository หรือไฟล์ที่เข้าถึงได้ จึงยังไม่ได้อัปโหลด ห้ามสร้างภาพปลอม/ใช้ภาพ mockup แทนต้นฉบับ

## สถานะโค้ดและระบบ
- Android project: `android-ocr-apk/`
- Android OCR ใช้ MediaProjection และ on-device ML Kit text recognition
- Workflow ล่าสุด: `.github/workflows/build-android-apk.yml`
- Commit `c84b7576537199303346b02faff7538400e758a0` — แก้ endpoint ใน Android `CaptureService.kt` เป็น `https://ai-signal-radar-dual.onrender.com/api/ocr/text`
- Dual backend Render service: `ai-signal-radar-dual`, branch `dual-system-independent`, start command `node dual-system/server.js`
- Dual backend มี `POST /api/ocr/text`, `GET /api/ocr/android-status` และ `POST /api/ocr/android-price`
- ยังไม่มีหลักฐานจากการทดสอบบนอุปกรณ์จริงว่า APK ส่ง OCR เข้า Render สำเร็จ และ OCR price candidates ยังต้องตรวจความถูกต้อง/ยืนยันก่อนใช้เป็นราคา

## ข้อกำหนดที่ต้องรักษา
1. อ่านทั้งราคา คู่เงิน และเวลาจากหน้าจอ ไม่ใช่จับเวลาอย่างเดียว
2. แยกข้อมูล OCR จริงออกจากค่าที่ระบบคำนวณ ห้ามเติมราคาหรือเดาตลาดเอง
3. เมื่ออ่านข้อมูลไม่ครบหรือไม่มั่นใจ ให้แสดง WAIT / STANDBY พร้อมเหตุผล
4. ห้ามส่งคำสั่งซื้อขายอัตโนมัติ ผู้ใช้เป็นผู้ตัดสินใจเอง
5. ห้ามใส่ API key, token, รหัสผ่าน หรือ secrets ลงใน GitHub
6. ห้ามรับประกัน win rate
7. ทุกครั้งที่แก้ไขหรือทดสอบ ต้องอัปเดตเอกสารส่งต่องานนี้ พร้อม branch, commit, ผลทดสอบ และสิ่งที่ยังไม่ยืนยัน

## ขั้นตอนต่อไป
1. ผู้ใช้ดาวน์โหลดและติดตั้ง Debug APK จาก artifact run #5
2. ทดสอบ Android permission / screen capture / OCR และตรวจว่าคู่เงิน ราคา countdown และ capturedAt ที่ส่งเข้า Render ตรงกับกราฟจริง
3. ตรวจ Render logs ว่ามี `POST /api/ocr/text` และสถานะตอบกลับสำเร็จ
4. ตรวจราคา candidate และการยืนยันราคา; ห้ามส่งสัญญาณ CALL/PUT จาก OCR ที่ยังไม่ยืนยัน
5. หลังผ่านทดสอบเครื่องจริง ค่อยทำ signed Release APK หากต้องการแจกจ่ายใช้งานต่อเนื่อง

เอกสารนี้เป็นบริบทสำหรับการทำงานต่อ ไม่ใช่หลักฐานว่าระบบผ่านการทดสอบใช้งานจริงแล้ว
