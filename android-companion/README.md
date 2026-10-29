# AI Signal Radar Android Companion (OTC capture prototype)

This Android app is a companion to the existing Telegram Mini App. It requests Android MediaProjection consent, runs OCR on-device with ML Kit, and sends only a candidate price, user-entered symbol, capture timestamp, and heuristic OCR confidence to the Render API.

## Privacy and limitations
- It does not ask for or store IQ Option credentials and never places trades.
- It does not upload screenshots or OCR text. OCR is performed locally.
- Screen capture can be blocked by Android or the broker app. OCR may select an axis label instead of the live price.
- The backend deliberately reports OTC as STANDBY. A single OCR price is not enough to validate a trading signal. Do not use this prototype to place trades.
- The capture process runs only after the user accepts Android's screen-sharing prompt and can be stopped from the app or Android's screen-sharing controls.

## Configure the Render API
1. In Render Dashboard, open the `my-ai-signal-bot` web service.
2. Add an environment variable named `OTC_INGEST_TOKEN` with a long random secret of your own. Do not commit it to GitHub or paste it into a public chat.
3. Deploy the code that includes `otc.js` and the `/api/otc` routes.
4. Keep the same secret available privately for the Android app's Token field.

## Build the Android app
1. Open the `android-companion` folder in Android Studio (a recent stable version with Android SDK 35).
2. Let Gradle sync and install the app on your Android phone.
3. In the app, enter the Render URL (`https://my-ai-signal-bot.onrender.com`), the `OTC_INGEST_TOKEN` secret, and the symbol label visible on the IQ Option chart.
4. Tap **อนุญาตและเริ่มอ่านหน้าจอ**, accept Android's screen-capture prompt, then switch to IQ Option and open the intended OTC chart.
5. Return to the Mini App and choose **OTC จากหน้าจอ**. The status should only show fresh data while the Android app is actively capturing.

## API
- `POST /api/otc/capture` requires `Authorization: Bearer <OTC_INGEST_TOKEN>`.
- `GET /api/otc/status` reports the latest capture only while it is no older than 15 seconds.

This is an integration prototype. Build and test on a real Android device before relying on it; no APK is attached or claimed to have been compiled by this repository update.