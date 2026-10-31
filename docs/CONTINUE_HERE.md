# CONTINUE HERE — AI SIGNAL RADAR OCR

อัปเดตบริบท: 31 ตุลาคม 2026

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
- Commit ล่าสุดที่ตรวจ: `18f397570e8ef4e7697c659b9e9200d6b408d717` — ตั้ง market type เป็น `UNCONFIRMED` หาก OCR ยังไม่ยืนยัน เพื่อป้องกันการเดาจากแท็บ OTC อื่นบนหน้าจอ
- Commit ก่อนหน้าเชื่อม Android ML Kit OCR feed เข้ากับ dual radar API แต่ต้องตรวจสอบและทดสอบ runtime จริงก่อนสรุปว่าใช้งานได้สมบูรณ์

## ข้อกำหนดที่ต้องรักษา
1. อ่านทั้งราคา คู่เงิน และเวลาจากหน้าจอ ไม่ใช่จับเวลาอย่างเดียว
2. แยกข้อมูลที่ OCR อ่านได้จริงออกจากค่าที่ระบบคำนวณ ห้ามเติมราคาหรือเดาตลาดเอง
3. เมื่ออ่านข้อมูลไม่ครบหรือไม่มั่นใจ ให้แสดง WAIT / STANDBY และเหตุผล ไม่ส่ง CALL/PUT ที่ไม่มีข้อมูลรองรับ
4. ห้ามส่งคำสั่งซื้อขายอัตโนมัติ ผู้ใช้เป็นผู้ตัดสินใจเอง
5. ห้ามใส่ API key, token, รหัสผ่าน, ข้อมูลบัญชี หรือ secrets ลงใน GitHub
6. ต้องทดสอบกับภาพหน้าจอจริงหลายกรณี รวมถึงภาพที่อ่านไม่ชัด ก่อนเรียกว่าใช้งานจริง
7. ไม่มีการรับประกัน win rate หรือจำนวนไม้ชนะ

## ขั้นตอนต่อไป
1. ตรวจสอบ Android capture service ว่าส่ง OCR payload ที่มี symbol, price, marketType และ timestamp ไป backend จริงหรือไม่
2. ตรวจสอบ backend ว่ารับ payload และแสดงค่าที่อ่านได้ใน dashboard ตรงกันหรือไม่
3. ทดสอบกรณีราคาไม่ครบ / คู่เงินไม่ชัด / marketType เป็น UNCONFIRMED
4. เพิ่มภาพอ้างอิงที่ 2 เมื่อมีไฟล์ต้นฉบับให้เข้าถึง
5. Build APK ผ่าน GitHub Actions และติดตั้งทดสอบบน Android จริง

เอกสารนี้เป็นบริบทสำหรับการทำงานต่อ ไม่ใช่หลักฐานว่าระบบผ่านการทดสอบใช้งานจริงแล้ว
