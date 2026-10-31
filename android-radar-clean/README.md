# AI Signal Radar OCR — Clean Android App

A new isolated Android application, separate from the previous Android source tree.

## Current milestone
- MediaProjection screen-capture consent flow
- Foreground capture service
- On-device ML Kit text recognition
- Basic extraction of visible currency pair, explicit market label, clock text and decimal-number candidates
- Ambiguous market labels remain UNKNOWN; ambiguous price candidates remain UNCONFIRMED
- No broker login, no order execution, and no trading signal in this capture-validation milestone

## Build
Use JDK 17 and Gradle 8.9:

```bash
gradle --no-daemon :app:assembleDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`

OCR only sees pixels currently displayed. It cannot retrieve hidden symbols or historical candles. A decimal OCR candidate is not a verified quote until region-based parsing and real-device checks confirm it against the chart.
