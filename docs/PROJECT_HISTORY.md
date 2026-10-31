# PROJECT HISTORY — AI SIGNAL RADAR OCR CLEAN REBUILD

วันที่จัดทำบันทึก: 31 ตุลาคม 2026  
Repository: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot  
Working branch: `ocr-dual-scan-clean`

เอกสารนี้บันทึกที่มา เป้าหมาย การตัดสินใจ ปัญหาที่พบ งานที่ทำแล้ว ผล Build และงานคงเหลือของโปรเจกต์ OCR Android ชุดใหม่ ตั้งแต่เริ่มแยกโปรเจกต์ ไม่ใช่เอกสารของระบบสัญญาณเทรดรุ่นเก่าหรือแอปทดลองเดิม

---

## 1. ที่มาและเหตุผลที่เริ่มโปรเจกต์ใหม่

ก่อนเริ่ม Clean Rebuild มีการทดลองทำแอป Android สำหรับอ่านหน้าจอแพลตฟอร์มเทรดและแสดงข้อมูลให้ระบบ AI Radar ใช้ แต่จากการติดตั้งและทดสอบจริงพบปัญหาสำคัญ เช่น
- แอปเปิดได้หรือมีหน้าต่างลอย แต่ไม่เห็นผลการอ่านข้อมูลตามที่คาดหวัง
- บางรอบอ่านตัวเลขเวลา/ตัวนับถอยหลังได้ แต่ไม่สามารถยืนยันว่าอ่านราคาได้ถูกต้อง
- ผู้ใช้ต้องการให้ระบบอ่านข้อมูลจากหน้าจอเทรดที่เปิดอยู่จริง ไม่ใช่แสดงข้อมูลจำลองหรือกำหนดคู่เงินไว้ล่วงหน้า
- การแก้โค้ดเดิมต่อไปเสี่ยงทำให้ปัญหาเดิมติดมาด้วย จึงตกลงเริ่มโครง Android ใหม่แยกจากแอปเดิม

ดังนั้นจึงสร้าง Clean Rebuild ในโฟลเดอร์ใหม่ `android-radar-clean/` และทำงานบน branch `ocr-dual-scan-clean` โดยไม่แก้ `main` หรือ source Android เดิม เว้นแต่ผู้ใช้จะสั่งโดยตรง

## 2. เป้าหมายที่ผู้ใช้ยืนยัน

1. อ่านข้อมูลจากหน้าจอแพลตฟอร์มเทรดที่ผู้ใช้เปิดอยู่จริง
2. ผู้ใช้เปลี่ยนคู่เงินหรือเปลี่ยนตลาด MAIN/OTC บนแพลตฟอร์มเอง แอปต้องติดตามหน้าจอปัจจุบัน ไม่ต้องให้ผู้ใช้เลือกคู่เงินซ้ำในแอป
3. รองรับทั้งตลาดหลัก MAIN/Non-OTC และ OTC โดยต้องแยกข้อมูลคนละตลาดอย่างเด็ดขาด
4. อ่านชื่อคู่เงิน ราคา เวลา และประเภทตลาดจากภาพหน้าจอ
5. มีโหมดอ่านอัตโนมัติ (Auto Scan/Auto-follow) และปุ่มสั่งอ่านซ้ำ (Manual Scan)
6. ใช้กรอบเวลาหลัก 1 นาที
7. เมื่อข้อมูลไม่ชัดเจนต้องไม่เดา:
   - ระบุตลาดไม่ได้ = `UNKNOWN`
   - มีตัวเลขราคาได้หลายค่า/ยังไม่ยืนยันว่าเป็นราคา = `UNCONFIRMED`
   - ราคาเก่า ไม่ครบ หรือ validation ไม่ผ่าน = ไม่ส่งสัญญาณ / `STANDBY`
8. แอปเป็นเครื่องมืออ่านและวิเคราะห์ประกอบการตัดสินใจ ผู้ใช้กดออเดอร์เอง
9. ไม่ต้องล็อกอินบัญชีโบรกเกอร์ ไม่ส่งคำสั่งซื้อขายอัตโนมัติ
10. ไม่กล่าวอ้าง Win Rate หรือความแม่นยำที่ยังไม่มีผลทดสอบรองรับ

## 3. ขอบเขตและข้อเท็จจริงทางเทคนิคที่ต้องจำ

- Android MediaProjection จับภาพหน้าจอได้เมื่อผู้ใช้ยินยอมผ่านหน้าต่างสิทธิ์ของ Android และเริ่มบริการจับภาพ
- OCR อ่านได้เฉพาะข้อความ/ตัวเลขที่มองเห็นอยู่ในภาพ ณ เวลานั้น
- OCR ไม่สามารถอ่านราคาของคู่เงินที่ซ่อนอยู่ หรือทุกคู่เงินพร้อมกัน หากแพลตฟอร์มไม่ได้แสดงข้อมูลเหล่านั้นบนจอ
- หากเป็นหน้า Watchlist จะอ่านได้เฉพาะแถวที่มองเห็นจริง และต้องตรวจตำแหน่ง/ความถูกต้องของแต่ละแถว
- การเปลี่ยนกราฟหรือสลับคู่เงินให้ผู้ใช้เป็นผู้ดำเนินการเองในระยะแรก แอปติดตามสิ่งที่แสดงอยู่ ไม่ควรสั่งควบคุมโบรกเกอร์โดยไม่ได้รับอนุญาต
- ตัวเลขทศนิยมที่ OCR พบเพียงอย่างเดียวไม่ถือเป็นราคา เพราะอาจเป็นแกนราคา, payout, จำนวนเงิน, ยอดบัญชี หรือข้อความอื่น
- ต้องเทียบผล OCR กับภาพหน้าจอจริงหลาย layout ก่อนประกาศว่าอ่านราคาได้ถูกต้อง
- ห้ามนำราคา MAIN ไปใช้แทน OTC หรือกลับกัน

## 4. การตัดสินใจด้านสถาปัตยกรรม

สร้างแอป Android ใหม่โดยใช้:
- Kotlin และ Android Gradle Plugin
- Android MediaProjection สำหรับ screen capture
- Foreground Service เพื่อให้การจับภาพทำงานต่อเนื่องตามข้อกำหนด Android
- Google ML Kit Text Recognition (Latin) สำหรับ OCR บนอุปกรณ์
- JDK 17, Gradle 8.9, Android Gradle Plugin 8.7.3, Kotlin 2.0.21
- Compile SDK 35, min SDK 26, target SDK 35

ไฟล์หลักที่สร้าง:
- `android-radar-clean/settings.gradle.kts`
- `android-radar-clean/build.gradle.kts`
- `android-radar-clean/gradle.properties`
- `android-radar-clean/app/build.gradle.kts`
- `android-radar-clean/app/src/main/AndroidManifest.xml`
- `android-radar-clean/app/src/main/java/com/aisignalradar/clean/MainActivity.kt`
- `android-radar-clean/app/src/main/java/com/aisignalradar/clean/CaptureService.kt`
- `android-radar-clean/README.md`
- `.github/workflows/build-android-clean.yml`

## 5. ลำดับงานและประวัติการพัฒนา

### ระยะเริ่มต้น — แยก Clean Rebuild
- ตกลงเริ่มโปรเจกต์ Android ใหม่ทั้งหมด เพื่อไม่สืบทอดปัญหาจาก source รุ่นก่อน
- สร้าง branch `ocr-dual-scan-clean`
- แยก source ใหม่ไว้ใน `android-radar-clean/`
- วาง workflow GitHub Actions สำหรับ Build APK โดยไม่แก้ main branch
- กำหนดให้เฟสแรกเน้นจับภาพหน้าจอและ OCR ก่อน ยังไม่ทำ signal engine จนกว่าจะอ่านราคาได้ถูกต้อง

### Build #1 — Baseline Android OCR
- GitHub Actions run ID: `41194243643`
- ผล: SUCCESS
- Artifact: `AI-Signal-Radar-OCR-Clean-debug`
- Artifact ID: `13040107932`
- ZIP size: 22,836,511 bytes
- SHA-256: `976218326c9c206624b7c55732c83e27a05f61bebf0256032fd0597293cf9419`
- Workflow: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194243643
- Build ผ่านในระดับ compile/package แต่ไม่ได้หมายความว่า OCR ราคาได้รับการยืนยันบนโทรศัพท์จริง

### ระยะปรับ OCR diagnostics
จากปัญหาการอ่านได้เฉพาะเวลา/มีตัวเลขหลายตำแหน่ง จึงปรับระบบให้แสดงหลักฐานสำหรับตรวจสอบ ไม่เลือกตัวเลขราคาแบบสุ่ม:
- อ่าน OCR blocks/lines และเก็บ bounding-box coordinates ของตัวเลขทศนิยม
- แสดงข้อความบรรทัดต้นทางที่พบ candidate เพื่อให้ตรวจได้ว่าตัวเลขมาจากส่วนใดของจอ
- กรองตัวเลขรูปแบบ comma thousands เช่น `10,000.00` ออกจาก price candidate เบื้องต้น เพื่อลดโอกาสนำยอดเงินบัญชีมาเป็นราคา
- จำกัดรอบ OCR ประมาณ 0.9 วินาที เพื่อลดภาระ CPU
- แสดง raw OCR text, จำนวน candidate, พิกัด และขนาดหน้าจอในหน้า diagnostic
- ถ้าพบ candidate เดียว ให้แสดงเพียง `CANDIDATE` ไม่เรียกว่า verified price
- ถ้าพบหลาย candidate ให้แสดง `UNCONFIRMED`
- ตรวจประเภทตลาดแบบ conservative: พบ OTC ชัดเจนจึงเป็น OTC; พบ MAIN/SPOT/FOREX ชัดเจนจึงเป็น MAIN; มิฉะนั้น UNKNOWN

### Build #4 — OCR diagnostics
- GitHub Actions run ID: `41194919179`
- ผล: SUCCESS
- Commit ของ source ที่ Build: `0a54047ae9fca851ed788a2ad52f72b70f61a087`
- Artifact: `AI-Signal-Radar-OCR-Clean-debug`
- Artifact ID: `13041020090`
- ZIP size: 22,843,015 bytes
- SHA-256: `9a3ef33fccac933a654e5d4ad3cfb19e131cbf8972190153e1b77b89cb3b627c`
- หมดอายุ: 30 พฤศจิกายน 2026
- Workflow: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41194919179
- Build และ upload artifact ผ่าน แต่ยังต้องทดสอบบนโทรศัพท์จริงเพื่อเทียบ OCR กับราคาที่แสดงบนแพลตฟอร์ม

### เอกสารส่งต่องาน
- `docs/DUAL_SCAN_REBUILD_PLAN.md` — ข้อกำหนดและแผนพัฒนา
- `docs/CONTINUE_HERE.md` — สถานะล่าสุดและจุดเริ่มงานครั้งถัดไป
- เอกสารฉบับนี้ `docs/PROJECT_HISTORY.md` — ประวัติโครงการตั้งแต่เริ่ม Clean Rebuild

## 6. สถานะปัจจุบัน ณ 31 ตุลาคม 2026

<ins>ทำแล้ว</ins>
- สร้าง branch แยกสำหรับ Clean Rebuild
- สร้างโครง Android ใหม่
- เพิ่ม MediaProjection + Foreground Service
- เพิ่ม ML Kit OCR
- แยกข้อความคู่เงิน/ตลาด/เวลา และ decimal candidates เบื้องต้น
- เพิ่ม diagnostics ของข้อความ OCR และพิกัด candidate
- Build #1 และ Build #4 ผ่าน GitHub Actions และมี artifact ให้ดาวน์โหลด

<ins>ยังไม่เสร็จ / ยังไม่ยืนยัน</ins>
- ยังไม่มีการยืนยันว่า OCR อ่านราคาตลาดจริงได้ถูกต้องบนอุปกรณ์และ layout ของผู้ใช้
- การหา price ROI ยังเป็นแบบ candidate scan กว้างทั้งภาพ ไม่ใช่ตัวอ่านราคาจากตำแหน่งกราฟที่ผ่านการ calibrate
- ปุ่ม Manual Scan ใน Build #4 ยังเป็นเพียง placeholder เปลี่ยนข้อความสถานะ ไม่ได้สั่ง OCR ใหม่ทันที
- ยังไม่มี floating overlay ที่สมบูรณ์เหนือแอปเทรด
- ยังไม่มีระบบ Auto-follow ที่ผ่านการทดสอบกรณีเปลี่ยนคู่/เปลี่ยนตลาด
- ยังไม่มี candle builder จากภาพ/ticks ที่ตรวจสอบความถูกต้องแล้ว
- ยังไม่มี EMA/RSI/MACD/price action signal engine ใน Clean Rebuild
- ยังไม่มีระบบบันทึกผลสัญญาณ/ทดสอบ Win Rate ในโปรเจกต์ใหม่นี้
- ยังไม่มี Release APK; artifact ที่สร้างเป็น debug build

## 7. งานถัดไปตามลำดับความสำคัญ

1. ให้ผู้ใช้ติดตั้ง Build #4 และเปิดหน้าจอเทรดจริง จากนั้นเริ่มจับภาพ OCR
2. ตรวจ screenshot ของหน้า diagnostic เทียบกับหน้าจอเทรด ณ เวลาเดียวกัน โดยเฉพาะชื่อคู่เงิน, OTC/MAIN, ราคา, เวลา, raw OCR และพิกัด candidate
3. ใช้ภาพจริงกำหนด ROI แยกบริเวณราคาให้ตรงกับ layout ของแพลตฟอร์ม หลีกเลี่ยงยอดเงินบัญชี, payout และแกนราคา
4. เพิ่ม price validation: รูปแบบทศนิยมตามคู่เงิน, ความต่อเนื่องของราคา, ตำแหน่งบนจอ, confidence และความสดของข้อมูล
5. แก้ Manual Scan ให้ส่ง action ไปยัง CaptureService และบังคับประมวลผลภาพรอบใหม่โดยไม่รอ throttle
6. ทดสอบเปลี่ยนคู่เงินและเปลี่ยน MAIN/OTC ว่าระบบติดตามจอใหม่และไม่ปะปนข้อมูล
7. เมื่อ OCR ผ่านเกณฑ์ จึงพัฒนา floating overlay, candle builder 1 นาที และ signal engine
8. ทดสอบบนโทรศัพท์จริงหลายคู่และหลาย layout ก่อนสร้าง Release APK

## 8. เกณฑ์ยอมรับก่อนนำไปใช้วิเคราะห์จริง

- ราคาอ่านตรงกับหน้าจอจริงและไม่สลับกับยอดเงิน/payout/แกนราคา
- คู่เงินและตลาดตรงกับหน้าจอปัจจุบัน
- เปลี่ยนคู่หรือ MAIN/OTC แล้วระบบอัปเดตได้โดยไม่ต้องเลือกคู่ในแอป
- ข้อมูลเก่า/ไม่ชัด/มีหลาย candidate ต้องหยุดที่ UNKNOWN, UNCONFIRMED หรือ STANDBY
- ไม่มีการส่งคำสั่งซื้อขายอัตโนมัติ
- มีผลทดสอบจริงบันทึกไว้ก่อนกล่าวถึงความแม่นยำหรือ Win Rate

## 9. ความปลอดภัยและการดูแล repository

- ห้าม commit Telegram token, API key, password, session cookie หรือข้อมูลเข้าสู่บัญชีใด ๆ
- ไม่ขอรหัสผ่านบัญชีโบรกเกอร์และไม่ทำ broker login
- เก็บงาน Clean Rebuild ใน branch แยกจนกว่าจะผ่านการทดสอบและผู้ใช้อนุมัติ
- ทุกครั้งที่มีการแก้ไข source หรือ Build ใหม่ ต้องอัปเดต `docs/CONTINUE_HERE.md` และเอกสารที่เกี่ยวข้อง พร้อมระบุ commit, run ID, artifact และผลทดสอบตามจริง
- ห้ามระบุว่า “พร้อมเทรดจริง” เพียงเพราะ Build ผ่าน

---

**หลักการของโปรเจกต์:** ทำให้ OCR อ่านข้อมูลจริงได้ถูกต้องก่อน แล้วค่อยสร้างการวิเคราะห์และสัญญาณ โดยไม่เดาข้อมูล ไม่สร้างราคาเทียม และไม่กล่าวอ้างผลลัพธ์เกินกว่าที่ทดสอบแล้ว



### การปรับตัวอ่านป้ายราคาที่เคลื่อนตามแท่งเทียน (31 ต.ค. 2026)
จากการทดสอบหน้าจอ Trade จริง ผู้ใช้ยืนยันว่าราคา EUR/USD (OTC) ที่ถูกต้องในภาพคือ `1.121115` ซึ่งเป็นตัวเลขทศนิยม 6 ตำแหน่ง ป้ายราคามีขนาดเล็กและเลื่อนขึ้น/ลงตามแท่งเทียน ไม่ได้อยู่พิกัด Y คงที่

การแก้ไข source:
- เปลี่ยนจากการพิจารณาตัวเลขทศนิยมทุกตำแหน่งแบบเท่า ๆ กัน เป็นการแยก live-price lane บริเวณขอบขวาของกราฟ และให้ความสำคัญกับตัวเลข 5–6 ตำแหน่ง
- เก็บพิกัด X/Y ของ candidate และติดตามตำแหน่งระหว่างเฟรม เพื่อรองรับการเลื่อนขึ้นลงของป้ายราคาตามแท่งเทียน
- แสดงค่าเป็น `LIVE CANDIDATE` เท่านั้นจนกว่าจะตรวจสอบจากการใช้งานจริงต่อเนื่อง; หากมี candidate กำกวมให้เป็น `UNCONFIRMED`
- แก้ปุ่ม Manual Scan ให้ส่ง action ไป CaptureService เพื่อข้ามช่วง throttle และอ่านเฟรมถัดไปจริง
- CaptureService commit: `0fb73e7937f94b9e3ec4bcd80da7fe215bb5a27c`
- MainActivity commit: `abaf8e53e5891961672ce427fb7c83da83883e40`
- เอกสารส่งต่องานอัปเดต commit: `de98d849e5e12613c728d073950f2a7430a15892`
- สถานะ: source push แล้ว; ต้องตรวจ GitHub Actions build และทดสอบ APK ใหม่บนโทรศัพท์จริงก่อนยืนยันว่าราคาอ่านตรงตลอดการเคลื่อนไหว



ผลการ Build สำหรับการปรับราคาที่เคลื่อนตามแท่งเทียน:
- GitHub Actions Build #6, run ID `41196754318`
- Commit source: `abaf8e53e5891961672ce427fb7c83da83883e40`
- ผล: `SUCCESS` (Build clean debug APK และ Upload artifact ผ่าน)
- Artifact ID: `13040563824`, ชื่อ `AI-Signal-Radar-OCR-Clean-debug`
- ZIP size: 22,848,298 bytes; หมดอายุ 30 พ.ย. 2026 เวลา 11:25:48 UTC
- Workflow: https://github.com/0953922631n5566-ctrl/my-ai-signal-bot/actions/runs/41196754318
- ข้อควรทราบ: ผ่านการ compile/package เท่านั้น ยังต้องติดตั้งและทดสอบเทียบป้ายราคาที่ขยับจริงบนโทรศัพท์ก่อนยืนยันความแม่นยำ
