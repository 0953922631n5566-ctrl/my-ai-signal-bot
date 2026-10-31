# AI Signal Radar Android Capture

This companion app captures the screen only after the user explicitly approves Android's MediaProjection dialog. It sends JPEG frames every 5 seconds to the existing Render OCR endpoint. It does not interact with the broker or place trades.

## Build
Open this folder in Android Studio, or use the GitHub Actions workflow in `.github/workflows/build-android-apk.yml`. The debug APK is published as a workflow artifact.

## Setup
1. Install the APK on Android.
2. Enter the Render service URL and the same SCREEN_INGEST_TOKEN configured on Render.
3. Select MAIN or OTC and the matching currency pair.
4. For OTC, confirm the chart really is OTC.
5. Tap Start screen sharing and approve Android's system prompt.
6. To stop, return to this app and tap Stop screen sharing.

Keep the 8xTrade chart visible while capture is running. Android/HyperOS may stop background capture under battery restrictions; allow the app to run in the background if needed.

The server currently aggregates sampled OCR prices into candles in memory. This is a capture companion, not a guarantee of correct OCR, candle reconstruction, or profitable signals. Verify displayed market and price before acting.
