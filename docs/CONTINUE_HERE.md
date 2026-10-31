# CONTINUE HERE — AI SIGNAL RADAR OCR CLEAN REBUILD

อัปเดต: 31 ตุลาคม 2026

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

## สถานะ / ข้อจำกัด
- GitHub Actions run #1 `41194243643` จบด้วย `success` และอัปโหลด artifact แล้ว
- Artifact: `AI-Signal-Radar-OCR-Clean-debug`, ID `13040107932`, ZIP 22,836,511 bytes, SHA-256 `976218326c9c206624b7c55732c83e27a05f61bebf0256032fd0597293cf9419`, หมดอายุ 30 พ.ย. 2026
- ดาวน์โหลดได้จากหน้า run: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194243643 (ส่วน Artifacts ด้านล่าง)
- Build ผ่านแล้ว แต่ยังไม่ได้ทดสอบบนโทรศัพท์ Android จริง
- เฟสนี้ยังไม่มี ROI price locator ที่แม่นยำ, overlay ลอยเหนือแอปเทรด, backend sync, candle builder หรือ signal engine
- อย่าส่ง APK ให้ผู้ใช้จนกว่า workflow ผ่านและตรวจ artifact ได้
- ห้ามอ้างว่าราคา OCR ถูกต้องจนกว่าจะเทียบกับหน้าจอจริงหลาย layout
- OCR อ่านได้เฉพาะสิ่งที่ปรากฏบนหน้าจอ; ไม่สามารถอ่านราคาคู่ที่ซ่อนอยู่
- ห้ามใส่ token/password/API key ใน GitHub

## ขั้นตอนถัดไป
1. ตรวจ GitHub Actions ของ workflow Build Clean Android OCR APK
2. ถ้า build fail ให้ดึง job logs และแก้ compile/config errors
3. เมื่อ build ผ่าน ตรวจ artifact แล้วค่อยส่ง APK ให้ผู้ใช้ติดตั้งทดสอบ
4. ให้ผู้ใช้ทดสอบเปิดหน้าเทรดและกดเริ่มอ่านหน้าจอ ตรวจว่าคู่เงิน ราคา เวลา และตลาดตรงกับภาพจริงหรือไม่
5. ใช้ภาพหน้าจอจริงของผู้ใช้เพื่อทำ ROI-specific price extraction และแก้กรณีอ่านแต่เวลา
6. เพิ่ม overlay, Auto-follow, Manual Scan, validation และ analysis หลัง OCR ผ่านเกณฑ์
