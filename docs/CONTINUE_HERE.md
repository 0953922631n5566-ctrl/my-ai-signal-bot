# CONTINUE HERE — AI SIGNAL RADAR OCR CLEAN REBUILD

อัปเดต: 31 ตุลาคม 2026 — ปรับตัวอ่านป้ายราคาที่เคลื่อนตามแท่งเทียน

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

## ปรับระบบตามผลทดสอบหน้าจอ Trade ของผู้ใช้ (31 ต.ค. 2026)
- ผู้ใช้ยืนยันว่าราคาปัจจุบันที่ถูกต้องในตัวอย่าง EUR/USD (OTC) คือ `1.121115` (ทศนิยม 6 ตำแหน่ง)
- ป้ายราคานี้เป็นตัวเลขขนาดเล็กบริเวณขอบขวาของกราฟ และเลื่อนขึ้น/ลงตามแท่งเทียน จึงห้ามกำหนดพิกัด Y แบบตายตัว
- `CaptureService.kt` ปรับให้แยก candidate ทศนิยม 5–6 ตำแหน่งใน lane ด้านขวาของพื้นที่กราฟ (x >= 55% ของจอ, y 18–88%) เป็น live-price candidates; ยังคงแสดง candidates ทั้งหมดเพื่อ diagnostics
- เพิ่มการติดตามพิกัด X/Y ของ candidate ระหว่างเฟรม เพื่อเลือกตัวที่ต่อเนื่องเมื่อมีหลาย candidate ใน live lane
- แสดงผลเป็น `LIVE CANDIDATE: <price>` เท่านั้น ไม่ใช่ราคา verified; หากกำกวมแสดง `UNCONFIRMED` และยังห้ามใช้สร้างสัญญาณ
- แก้ปุ่ม Manual Scan ให้ส่ง `ACTION_MANUAL_SCAN` ไป CaptureService เพื่อข้าม frame throttle และสั่งอ่านเฟรมถัดไปจริง
- Source commits: CaptureService `0fb73e7937f94b9e3ec4bcd80da7fe215bb5a27c`; MainActivity `abaf8e53e5891961672ce427fb7c83da83883e40`
- GitHub Actions Build #6: run ID `41196754318`, commit `abaf8e53e5891961672ce427fb7c83da83883e40`, ผล `SUCCESS`; build step และ upload step ผ่าน
- Artifact ใหม่: `AI-Signal-Radar-OCR-Clean-debug`, ID `13040563824`, ZIP 22,848,298 bytes, หมดอายุ 30 พ.ย. 2026 เวลา 11:25:48 UTC
- ดาวน์โหลด APK ใหม่จาก https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41196754318 (เลื่อนลงไปที่ Artifacts แล้วดาวน์โหลด ZIP และแตกไฟล์ `app-debug.apk`)
- Build ผ่านในระดับ compile/package เท่านั้น; ยังต้องทดสอบ OCR กับป้ายราคาที่เคลื่อนจริงก่อนถือว่าราคาแม่นยำ

## สถานะ / ข้อจำกัด
- GitHub Actions run #1 `41194243643` จบด้วย `success` และอัปโหลด artifact แล้ว
- Artifact: `AI-Signal-Radar-OCR-Clean-debug`, ID `13040107932`, ZIP 22,836,511 bytes, SHA-256 `976218326c9c206624b7c55732c83e27a05f61bebf0256032fd0597293cf9419`, หมดอายุ 30 พ.ย. 2026
- ดาวน์โหลดได้จากหน้า run: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194243643 (ส่วน Artifacts ด้านล่าง)
- Build ผ่านแล้ว แต่ยังไม่ได้ยืนยันความถูกต้องของ OCR ราคาบนโทรศัพท์จริง
- ตัวกรอง live-price lane เป็น heuristic จากรูปแบบทศนิยม/บริเวณขอบขวา ยังต้องทดสอบกับภาพจริงและหลายคู่เงินก่อนถือว่าแม่นยำ; ยังไม่มี ROI แบบภาพ/สีเฉพาะแพลตฟอร์ม, overlay ลอยเหนือแอปเทรด, backend sync, candle builder หรือ signal engine
- Manual Scan ใน source ล่าสุดเชื่อม action แล้ว แต่ต้องรอ APK build ใหม่และทดสอบบนเครื่องจริง
- ห้ามอ้างว่าราคา OCR ถูกต้องจนกว่าจะเทียบกับหน้าจอจริงหลาย layout
- OCR อ่านได้เฉพาะสิ่งที่ปรากฏบนหน้าจอ; ไม่สามารถอ่านราคาคู่ที่ซ่อนอยู่
- ห้ามใส่ token/password/API key ใน GitHub

## ขั้นตอนถัดไป
1. ตรวจ GitHub Actions build ที่เกิดจาก source commits ล่าสุด และยืนยัน artifact ใหม่
2. ให้ผู้ใช้ติดตั้ง APK build ใหม่ เปิด EUR/USD (OTC) และเทียบว่าราคาแสดง LIVE CANDIDATE ตรงกับป้ายที่เลื่อนตามแท่งเทียนหรือไม่
3. ทดสอบขณะราคาขยับขึ้น/ลงหลายรอบ เพื่อยืนยันว่าพิกัด Y เปลี่ยนตามป้ายราคา ไม่ยึดตำแหน่งเดิม
4. ตรวจ false positives จากตัวเลข 5–6 ตำแหน่งอื่นในกราฟ; ปรับ lane/temporal tracking จากผลภาพจริง
5. ทดสอบ Manual Scan ว่าสั่งอ่านรอบใหม่ได้ทันที
6. ขยายกฎ precision ให้เหมาะกับคู่เงินอื่น โดยไม่ทำให้ราคาแกนกราฟถูกเลือก
7. ทดสอบเปลี่ยนคู่เงินและ MAIN/OTC ว่าตามหน้าจอได้และไม่ปะปนข้อมูล
8. หลัง OCR ผ่านเกณฑ์ ค่อยเพิ่ม overlay, candle builder, indicators และ signal engine
9. อัปเดตเอกสารนี้ทุกครั้งที่มี commit/build/test ใหม่ พร้อมระบุผลจริง

## หลักการส่งต่องาน
เริ่มอ่าน `docs/PROJECT_HISTORY.md` เพื่อเข้าใจที่มาและการตัดสินใจทั้งหมด จากนั้นอ่านเอกสารนี้เพื่อดูสถานะปัจจุบันและงานถัดไป ห้ามเริ่มใหม่หรือเปลี่ยนขอบเขตโดยไม่ตรวจเอกสารทั้งสองก่อน



## ผลทดสอบจากเครื่องผู้ใช้หลัง Build #6 (31 ต.ค. 2026)
- หน้าจอ Trade แสดง EUR/USD (OTC), 1m; OCR อ่านคู่เงิน EUR/USD ได้
- OCR เลือก live-lane candidate `1.120825 @ 916,1168` ซึ่งอยู่บริเวณขอบขวาของกราฟตามตำแหน่งที่คาดว่าจะเป็นป้ายราคาปัจจุบัน
- พบ candidate อื่น `1.120795` ที่ x ประมาณ 310–320 จึงไม่ถูกเลือกเพราะอยู่นอก right-side lane
- ตลาดกลับแสดง UNKNOWN ทั้งที่หน้าจอมีข้อความ OTC/OTC Blitz; สาเหตุที่เป็นไปได้คือ ML Kit รวมตัวอักษรข้างเคียงเป็น token เช่น `OTCE` ทำให้ regex แบบ word boundary ไม่พบ
- แก้ market detection ให้ตรวจข้อความ OCR ทีละบรรทัดหลัง normalize ตัวอักษร และรองรับ label ที่ OCR รวมอักขระติดกัน; OTC มี priority เหนือ MAIN
- Source commit: `cd89078185d80cb21b1f5868aaa20f9cec8bd9c7`
- GitHub Actions run: `41197501581` (เริ่ม build แล้ว; รอผล)
- ข้อสังเกต: `LIVE CANDIDATE 1.120825` ยังเป็น candidate ไม่ใช่ verified quote; ต้องเทียบกับป้ายราคาในกราฟ ณ เวลาเดียวกันต่อเนื่องหลายเฟรมก่อนใช้คำนวณสัญญาณ
- เวลาที่อ่านได้ `18:25:00` อาจเป็นเวลา tick/แกนกราฟ ไม่ควรถือเป็นนาฬิกาปัจจุบันจนกว่าจะกำหนด ROI และทดสอบตำแหน่งเวลาให้ชัด


## Latest user test and follow-up fix (31 Oct 2026)
Build #7 run 41197501581 succeeded (artifact 13041109349). User confirmed pair EUR/USD and market OTC are now parsed correctly. Price remained UNCONFIRMED with zero live-lane candidates; the prior x >= 55% screen-width threshold excluded the visible chart quote area. Source was adjusted in commit ae3d0273561a6e3b54e8937fd9cb9c8f54e08a3a: lane now starts at 40% screen width and vertical range is 15-93%. Ambiguous candidates remain UNCONFIRMED. Build #8 run 41198590130 is currently in progress; do not distribute Build #7 as containing this lane fix.

Build #8 update: run 41198590130 completed SUCCESS for commit ae3d0273561a6e3b54e8937fd9cb9c8f54e08a3a. Artifact ID 13041746670, ZIP 22,851,328 bytes, SHA-256 dff69cd78f98fa7ddc99721d28d91e241ff7ffa7601ce20a7e0959a9e6126785, expires 30 Nov 2026. Download from https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41198590130. Build success confirms APK packaging only; live price remains unverified pending user test.


## User-defined live-price red rectangle ROI (31 Oct 2026)
ผู้ใช้ยืนยันให้ถือว่าราคาอยู่ภายในกรอบสี่เหลี่ยมสีแดงบริเวณพื้นที่ว่างด้านขวาของกราฟ โดยประมาณ:
- ความกว้าง 25–30% ของพื้นที่กราฟ; เริ่มบริเวณเส้นแบ่งเวลาแนวตั้งและจบก่อนแผงปุ่มเทรด
- ความสูง 75–80%; เริ่มใต้แถบยอดเงินและจบเหนือแถบเวลาใต้กราฟ
- ปรับ CaptureService.kt ให้ใช้ normalized ROI โดยประมาณบนภาพเต็มจอ: X = 55–85%, Y = 11–90%; กรองเฉพาะเลขทศนิยม 5–6 ตำแหน่งที่อยู่ภายในกรอบนี้
- ยังคงติดตาม X/Y ของป้ายราคาในเฟรมถัดไป; ถ้าพบหลาย candidate และแยกไม่ได้ให้เป็น UNCONFIRMED ห้ามเดา
- Source commit: 9b84f406c2adf5b75d38c75e20d4b1e319091212
- การกำหนดนี้เป็นพิกัดประมาณจากคำอธิบายสัดส่วน ยังไม่ใช่ pixel-perfect calibration จาก screenshot เต็มจอ; ต้องตรวจผลจาก APK บนโทรศัพท์จริงก่อนยืนยันความถูกต้อง
- Build ใหม่จะเริ่มจาก push source ไป branch ocr-dual-scan-clean; รอ GitHub Actions run และ artifact ก่อนส่ง APK

### ROI Build #9 result (31 Oct 2026)
- GitHub Actions run: 41200690320; status completed / conclusion SUCCESS; source commit 9b84f406c2adf5b75d38c75e20d4b1e319091212
- Artifact: AI-Signal-Radar-OCR-Clean-debug, ID 13042815806, ZIP 22,851,460 bytes, SHA-256 02351f80d7b08de727176775f996ae50a12ca60386db6561472090069a696090; expires 30 Nov 2026 12:21:29 UTC
- Workflow URL: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41200690320
- Build ผ่าน compile/package; ยังไม่ใช่การยืนยัน OCR ราคาบนอุปกรณ์จริง ต้องติดตั้งและทดสอบกรอบ ROI ใหม่ก่อน


## Orange Price Badge detection (31 Oct 2026)
ผู้ใช้ระบุเป้าหมายใหม่ให้ตรวจจับป้ายราคาปัจจุบันสีส้มที่มีปลายแหลมด้านซ้ายและตัวเลขอยู่ภายใน แทนการเลือกเลขทศนิยมจาก ROI แบบกว้าง
- CaptureService สแกนพิกเซลสีส้มเฉพาะโซนขวาของกราฟ (X 55–85%, Y 11–90%) และคำนวณกรอบจากแถวพิกเซลสีส้มที่ต่อเนื่องในแนวตั้งใหม่ทุกเฟรมที่ประมวลผล
- กรอบครอบเฉพาะกลุ่มป้าย/เส้นราคาสีส้มที่ตรวจพบ ไม่ใช้กรอบ Y ตายตัว; ใช้ตำแหน่งกรอบเป็น gate ให้ OCR เลือกเฉพาะตัวเลข 5–6 หลักที่อยู่ในป้าย
- ถ้าไม่พบป้ายสีส้มหรือไม่พบตัวเลขที่สอดคล้อง จะคง UNCONFIRMED; ไม่ fallback ไปหยิบตัวเลขอื่นบนจอ
- ปรับช่วงประมวลผลจาก 900ms เป็น 300ms เพื่อให้ติดตามการเลื่อนขึ้นลงได้ถี่ขึ้น (ขึ้นกับความเร็ว OCR/อุปกรณ์)
- Source commits: detector f97e28c46ebad586fd30dab1bd1f43f4c43df32c; tight-box refinement dae7682a9b1c5b191ff3ec4761adccc7a353d8cc
- Diagnostics แสดง bbox เป็นพิกัดพิกเซลและรายการตัวเลขที่อยู่ภายในกรอบ; ต้องทดสอบบนหน้าจอจริงเพื่อยืนยันค่าสี/ขนาดป้ายและความถูกต้องของกรอบ
- ข้อจำกัดปัจจุบัน: กรอบเป็นผลตรวจจับ/พิกัดใน diagnostics ยังไม่ได้วาดเป็นกรอบทับบนหน้าจอแอปเทรด และ 300ms เป็นรอบพยายามประมวลผล ไม่ใช่การรับประกันว่า OCR จะเสร็จทุก 300ms
- รอ GitHub Actions build ใหม่และทดสอบ APK บนโทรศัพท์ก่อนประกาศว่าอ่านราคาได้ถูกต้อง
