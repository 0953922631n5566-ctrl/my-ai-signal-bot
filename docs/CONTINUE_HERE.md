# CONTINUE HERE — AI SIGNAL RADAR OCR CLEAN REBUILD

อัปเดต: 31 ตุลาคม 2026

## เอกสารหลักของโปรเจกต์
- **ประวัติตั้งแต่เริ่มโครงการ:** [docs/PROJECT_HISTORY.md](PROJECT_HISTORY.md)
- **ข้อกำหนดและแผนพัฒนา:** [docs/DUAL_SCAN_REBUILD_PLAN.md](DUAL_SCAN_REBUILD_PLAN.md)
- เอกสารหน้านี้ใช้ส่งต่องานและระบุสถานะล่าสุด

## Repository
- https://github.com/0953922631n5566-ctrl/my-ai-signal-bot
- Branch ทำงานใหม่: `ocr-dual-scan-clean`
- ห้ามแก้ branch main หรือโค้ด Android เดิมเพื่อทำงาน Clean Rebuild นี้ เว้นแต่ผู้ใช้สั่งโดยตรง

## เป้าหมายที่ยืนยันแล้ว
- Android OCR อ่านหน้าจอเทรดจริง ไม่ใช่ข้อมูลจำลอง
- ผู้ใช้เปลี่ยนคู่เงินหรือ MAIN/OTC บนแพลตฟอร์มเอง แอปติดตามหน้าจอปัจจุบันโดยอัตโนมัติ
- มี Auto-follow และ Manual Scan; ไม่บังคับเลือกคู่เงินในแอป
- OCR อ่านชื่อคู่เงิน ราคา เวลา และประเภทตลาด
- ตลาดไม่ชัด = UNKNOWN; ราคาไม่ชัด/หลาย candidate = UNCONFIRMED; งดสัญญาณ
- กรอบหลัก 1 นาที; MAIN และ OTC ต้องแยกจากกัน
- ผู้ใช้กดซื้อขายเอง ไม่มี broker login หรือ auto-order

## โครงสร้างใหม่ที่สร้างแล้ว
- `android-radar-clean/settings.gradle.kts`
- `android-radar-clean/build.gradle.kts`
- `android-radar-clean/gradle.properties`
- `android-radar-clean/app/build.gradle.kts`
- `android-radar-clean/app/src/main/AndroidManifest.xml`
- `android-radar-clean/app/src/main/java/com/aisignalradar/clean/MainActivity.kt`
- `android-radar-clean/app/src/main/java/com/aisignalradar/clean/CaptureService.kt`
- `android-radar-clean/README.md`
- workflow: `.github/workflows/build-android-clean.yml`

## สิ่งที่เฟสแรกทำ
- ขอสิทธิ์ MediaProjection ผ่าน Android system prompt
- ใช้ Foreground Service จับภาพหน้าจอ
- ใช้ ML Kit Text Recognition บนอุปกรณ์
- แสดงข้อความ OCR และ parse คู่เงิน/ตลาด/เวลา/decimal candidates เบื้องต้น
- ถ้าตลาดไม่ระบุชัดจะเป็น UNKNOWN
- ถ้าพบตัวเลขทศนิยมหลายค่า จะไม่เลือกเอง แต่ขึ้น UNCONFIRMED

## อัปเดต OCR diagnostics (31 ต.ค. 2026)
- ปรับ `CaptureService.kt` ให้ส่ง bounding-box coordinates ของเลขทศนิยมที่ OCR พบ พร้อมข้อความบรรทัดต้นทาง
- กรองเลขแบบ comma thousands เช่น `10,000.00` ออกจาก price candidate เพื่อลดการสับสนกับยอดเงินบัญชี
- จำกัดการอ่าน OCR ประมาณทุก 0.9 วินาที เพื่อลดการใช้ CPU
- หน้าจอแสดงรายการ candidate + ตำแหน่ง + ข้อความ OCR ดิบเพื่อ calibrate กับภาพจริง
- ค่าเดียวก็ยังติดป้าย CANDIDATE ไม่ถือเป็นราคา verified; หลายค่าขึ้น UNCONFIRMED
- GitHub Actions run #4: `41194919179` SUCCESS; artifact ID `13041020090`, size 22,843,015 bytes, SHA-256 `9a3ef33fccac933a654e5d4ad3cfb19e131cbf8972190153e1b77b89cb3b627c`, expires 30 พ.ย. 2026. ดาวน์โหลดจาก https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194919179

## สถานะ / ข้อจำกัด
- GitHub Actions run #1 `41194243643` จบด้วย `success` และอัปโหลด artifact แล้ว
- Artifact: `AI-Signal-Radar-OCR-Clean-debug`, ID `13040107932`, ZIP 22,836,511 bytes, SHA-256 `976218326c9c206624b7c55732c83e27a05f61bebf0256032fd0597293cf9419`, หมดอายุ 30 พ.ย. 2026
- ดาวน์โหลดได้จากหน้า run: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194243643 (ส่วน Artifacts ด้านล่าง)
- Build ผ่านแล้ว แต่ยังไม่ได้ยืนยันความถูกต้องของ OCR ราคาบนโทรศัพท์จริง
- เฟสนี้ยังไม่มี ROI price locator ที่แม่นยำ, overlay ลอยเหนือแอปเทรด, backend sync, candle builder หรือ signal engine
- ปุ่ม Manual Scan ใน Build #4 ยังเป็น placeholder; ต้องเชื่อม action เพื่อสั่ง OCR ใหม่จริง
- ห้ามอ้างว่าราคา OCR ถูกต้องจนกว่าจะเทียบกับหน้าจอจริงหลาย layout
- OCR อ่านได้เฉพาะสิ่งที่ปรากฏบนหน้าจอ; ไม่สามารถอ่านราคาคู่ที่ซ่อนอยู่
- ห้ามใส่ token/password/API key ใน GitHub

## ขั้นตอนถัดไป
1. ตรวจสอบ/ใช้ artifact จาก GitHub Actions run #4
2. ให้ผู้ใช้เปิดหน้าเทรดจริง เริ่ม OCR และส่งภาพหน้า diagnostic ที่เห็นผลอ่าน เพื่อเทียบคู่เงิน ตลาด ราคา เวลา และพิกัด candidate
3. ใช้ภาพจริงกำหนด ROI สำหรับอ่านราคา และแยกยอดเงินบัญชี/payout/แกนราคาออกจากราคา
4. เพิ่ม validation ราคาและความสดของข้อมูล ก่อนอนุญาตให้ระบบใช้ราคา
5. แก้ Manual Scan ให้สั่ง OCR รอบใหม่ทันที ไม่ใช่เพียงเปลี่ยนข้อความสถานะ
6. ทดสอบการเปลี่ยนคู่เงินและเปลี่ยน MAIN/OTC ว่าตามหน้าจอได้และไม่ปะปนข้อมูล
7. หลัง OCR ผ่านเกณฑ์ ค่อยเพิ่ม overlay, candle builder, indicators และ signal engine
8. อัปเดตเอกสารนี้ทุกครั้งที่มี commit/build/test ใหม่ พร้อมระบุผลจริง

## หลักการส่งต่องาน
เริ่มอ่าน `docs/PROJECT_HISTORY.md` เพื่อเข้าใจที่มาและการตัดสินใจทั้งหมด จากนั้นอ่านเอกสารนี้เพื่อดูสถานะปัจจุบันและงานถัดไป ห้ามเริ่มใหม่หรือเปลี่ยนขอบเขตโดยไม่ตรวจเอกสารทั้งสองก่อน
