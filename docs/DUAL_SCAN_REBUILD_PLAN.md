# AI SIGNAL RADAR PRO — Clean Rebuild Specification

สถานะ: พัฒนาโครง Android ใหม่ เฟสแรก (Capture + OCR)
วันที่อัปเดต: 31 ตุลาคม 2026
Branch: `ocr-dual-scan-clean`

## เป้าหมาย
สร้าง Android APK ใหม่แยกจากโค้ดเดิม อ่านข้อมูลจากหน้าจอแพลตฟอร์มเทรดจริง รองรับ MAIN/Non-OTC และ OTC โดยผู้ใช้เปิดกราฟและกดซื้อขายเอง ไม่มีการล็อกอินโบรกเกอร์และไม่มี auto-trading

## รูปแบบสแกน
- **Auto-follow active screen:** ตรวจจับสิ่งที่แสดงอยู่บนหน้าจอที่ผู้ใช้เปิด/เปลี่ยนเอง โดยไม่ต้องเลือกคู่เงินซ้ำในแอป
- **Manual Scan:** ผู้ใช้สั่งอ่านหน้าจออีกครั้งได้
- OCR อ่านได้เฉพาะพิกเซลที่ปรากฏบนหน้าจอ ไม่สามารถดึงราคาของคู่ที่ซ่อนอยู่หรือทุกคู่พร้อมกันเองได้
- Watchlist อ่านได้เท่าที่แสดงจริง; การเปลี่ยนกราฟแทนผู้ใช้จะไม่ทำจนกว่าจะมีวิธีที่ได้รับอนุญาตและทดสอบได้
- ห้ามเดาตลาด: พบคำว่า OTC ชัดเจนจึงระบุ OTC; พบ MAIN/SPOT/FOREX ชัดเจนจึงระบุ MAIN; นอกนั้น UNKNOWN

## โครงสร้างใหม่
แอปใหม่อยู่ใน `android-radar-clean/` ไม่ใช้ source จาก `android-ocr-apk/`
- Android MediaProjection ขออนุญาตจับภาพหน้าจอ
- Foreground service พร้อม notification แสดงสถานะการจับภาพ
- ML Kit Text Recognition ประมวลผลบนอุปกรณ์
- แยกข้อความคู่เงิน ป้ายตลาด เวลา และตัวเลขทศนิยมที่มองเห็น
- ถ้ามีตัวเลขราคาได้หลาย candidate ให้แสดง UNCONFIRMED แทนการเลือกตัวเลขเอง
- เฟสแรกยังไม่ส่ง backend และยังไม่ออก CALL/PUT จนกว่าการอ่านราคาจากบริเวณกราฟจะผ่านการทดสอบจริง

## เฟสพัฒนา
1. Capture + OCR พื้นฐาน (กำลังทำ)
2. แยก ROI ตามตำแหน่งชื่อคู่เงิน ป้ายตลาด ราคา เวลา และกราฟ พร้อม confidence
3. ทดสอบกับภาพจริงหลายคู่ MAIN/OTC และแก้ปัญหา OCR ราคา
4. เพิ่ม Auto-follow + Manual Scan และตรวจการเปลี่ยนคู่/ตลาด
5. สร้าง ticks/candles 1 นาทีจากภาพที่อ่านได้ต่อเนื่อง โดยแสดงข้อจำกัดข้อมูลย้อนหลัง
6. เพิ่ม EMA/RSI/MACD/price action และสัญญาณ CALL/PUT/STANDBY พร้อมเหตุผล
7. บันทึกประวัติ ทดสอบเครื่องจริง และสร้าง Release APK เมื่อผ่านเกณฑ์

## เกณฑ์ห้ามลด
- ไม่อ่านราคาได้ = ไม่มีสัญญาณ
- ตลาด UNKNOWN = ไม่มีสัญญาณ
- ราคา stale หรือไม่ผ่าน validation = STANDBY
- ห้ามผสมข้อมูล MAIN กับ OTC
- ไม่รับประกัน Win Rate และไม่แสดงผลทดสอบที่ไม่ได้ทำ
- ผู้ใช้เป็นผู้กดออเดอร์เอง

## สถานะล่าสุด
- สร้าง branch `ocr-dual-scan-clean` แยกจาก main แล้ว
- สร้างแอป Android ใหม่ `android-radar-clean/` และ workflow `.github/workflows/build-android-clean.yml`
- มี MediaProjection capture service และ ML Kit OCR เบื้องต้น
- GitHub Actions Build Clean Android OCR APK run #1: SUCCESS, run ID `41194243643`
- Artifact `AI-Signal-Radar-OCR-Clean-debug`, artifact ID `13040107932`, ZIP 22,836,511 bytes, SHA-256 `976218326c9c206624b7c55732c83e27a05f61bebf0256032fd0597293cf9419`, expires 30 พ.ย. 2026
- Workflow URL: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194243643
- Build ผ่าน แต่ยังไม่ได้ทดสอบบนโทรศัพท์จริง; จึงยังไม่รับรอง OCR ราคา/ตลาดในทุก layout
