# 8xTrade Screen Companion — ส่วนเสริมแยกสำหรับ AI Signal Radar

ส่วนเสริมนี้เพิ่มการรับข้อมูลจาก OCR บน Android โดยไม่ลบแหล่งข้อมูล Twelve Data เดิม

## ความปลอดภัยและข้อจำกัด
- ไม่เข้าสู่ระบบ 8xTrade, ไม่เก็บรหัสผ่าน/OTP และไม่มีคำสั่งซื้อขาย
- Android MediaProjection ต้องให้ผู้ใช้ยินยอมทุกครั้งที่เริ่ม session
- ตัวอย่างนี้จับภาพทั้งหน้าจอ ไม่ใช่เฉพาะหน้าต่าง 8xTrade; เมื่อสลับไป Telegram ภาพอาจเป็นหน้า Telegram
- OCR จากหน้าจอไม่ใช่ข้อมูลราคาอย่างเป็นทางการของโบรกเกอร์ อาจอ่านผิด และระบบจะ STANDBY หากไม่มีข้อมูลสด/ตัวเลขอ่านไม่ได้
- สร้างแท่ง 1 นาทีจากตัวอย่างราคาที่ OCR อ่านได้ ไม่ใช่แท่ง OHLC ที่มาจาก API ของ 8xTrade
- ต้องทดสอบบัญชีทดลองและตรวจสอบราคา/เวลาอย่างน้อยหลายรอบก่อนใช้งานจริง

## ติดตั้งฝั่ง Render
1. เพิ่มไฟล์ \`screen-source.js\` ใน root
2. ใน \`server.js\` เพิ่ม:
   \`\`\`js
   const { createScreenSource } = require("./screen-source");
   const screenSource = createScreenSource({ token: process.env.SCREEN_INGEST_TOKEN });
   app.use("/api/screen", screenSource.router);
   \`\`\`
3. เพิ่ม Environment Variable \`SCREEN_INGEST_TOKEN\` เป็นค่าสุ่มยาวอย่างน้อย 32 ตัวอักษร
4. Endpoint สำหรับส่งข้อมูล: \`POST /api/screen/ingest\` (Bearer token)
5. Endpoint สำหรับสถานะ: \`GET /api/screen/status\`

Payload ที่รับ:
\`\`\`json
{
  "version": 1,
  "symbol": "EUR/USD",
  "price": 1.08234,
  "capturedAt": "2026-10-29T10:00:01.000Z",
  "confidence": 0.8
}
\`\`\`
ค่า confidence เป็นคะแนนความมั่นใจของตัวแยกตัวเลขแบบ heuristic ไม่ใช่ค่าความมั่นใจที่ ML Kit รับประกัน

## สร้าง Android APK
1. เปิดโฟลเดอร์ \`android/\` ใน Android Studio (JDK 17)
2. รอ Gradle Sync แล้ว Build > Build APK(s)
3. ติดตั้งบน Xiaomi 11T, ใส่ URL HTTPS ของ Render, token และคู่เงิน
4. กด Start capture และยืนยันกล่องอนุญาตของ Android
5. เปิด 8xTrade และตรวจว่า endpoint \`/api/screen/status\` อัปเดตเวลา/ราคา
6. หากราคา OCR ไม่ตรงกับกราฟ ให้หยุดใช้และปรับการเลือกบริเวณราคาก่อน

อย่า commit token หรือ API key ลง GitHub และอย่าเปิดเผย token ในหน้า Mini App.
