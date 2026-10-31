# AI SIGNAL RADAR OCR

โปรเจกต์ Android OCR + AI Signal Radar สำหรับอ่านข้อมูลจากหน้าจอกราฟและส่งข้อมูลไปยังระบบวิเคราะห์ภายนอก

## ภาพอ้างอิง

- [Screenshot 1 — 31 ต.ค. 2026](./Screenshot_2026-10-31-10-26-00-457_com.android.chrome.jpg)
- ภาพอ้างอิงที่ 2: ยังไม่พบไฟล์ต้นฉบับใน repository ณ วันที่ 31 ต.ค. 2026 จึงยังไม่สร้างไฟล์แทนหรือใช้ภาพอื่นแทน

## โครงสร้างหลัก

- `server.js` — backend API และ WebSocket
- `public/` — หน้าเว็บแดชบอร์ด
- `android-ocr-apk/` — Android app สำหรับจับภาพหน้าจอและอ่านข้อความด้วย ML Kit
- `.github/workflows/build-android-ocr.yml` — GitHub Actions สำหรับ build APK
- `render.yaml` — การตั้งค่า deploy บน Render

## สถานะและข้อควรระวัง

- Android OCR ใช้ MediaProjection ซึ่งต้องให้ผู้ใช้ยืนยันการจับภาพหน้าจอผ่าน dialog ของ Android
- แอป OCR ไม่ควรอ่านรหัสผ่านหรือส่งคำสั่งซื้อขายแทนผู้ใช้
- OCR อาจอ่านตัวเลขผิดได้ ต้องตรวจสอบคู่เงิน ราคา เวลา และชนิดตลาดก่อนนำไปวิเคราะห์
- โค้ดล่าสุดตั้งชนิดตลาดเป็น `UNCONFIRMED` เมื่อยังยืนยันไม่ได้ ห้ามเดาว่าเป็น OTC หรือ Digital จากแท็บอื่นที่มองเห็นบนหน้าจอ
- ห้ามอ้างว่าได้ทดสอบสัญญาณหรือความแม่นยำจริง หากยังไม่มีผลทดสอบกับข้อมูลจริง

## ทำ APK

เปิดแท็บ **Actions** ใน GitHub แล้วรัน workflow **Build Android OCR APK** จากนั้นดาวน์โหลด artifact `AI-Signal-Radar-OCR-debug`

## สำหรับห้องสนทนาถัดไป

ให้อ่าน [docs/CONTINUE_HERE.md](./docs/CONTINUE_HERE.md) ก่อนแก้โค้ด เพื่อทราบบริบทล่าสุดและข้อจำกัดของระบบ
