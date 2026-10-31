# AI SIGNAL RADAR OCR — Clean Rebuild

## Current milestone: OCR diagnostics build
- Separate Android project: `android-radar-clean/`
- MediaProjection screen capture + foreground service
- On-device ML Kit Latin text recognition
- Screen OCR extracts visible pair label, explicit OTC/MAIN indicator, clock text, and decimal candidates with bounding-box coordinates
- Grouped numbers such as `10,000.00` are excluded from the decimal candidate parser to reduce account-balance confusion
- OCR runs at a throttled interval (about 0.9 seconds) to reduce unnecessary CPU load
- The app displays candidate coordinates and raw recognized text to support layout-specific calibration

## Safety / correctness
- A single decimal candidate is still labeled CANDIDATE, not a verified quote.
- Multiple candidates remain UNCONFIRMED; no signal is generated.
- Market not explicit = UNKNOWN.
- No broker login, order execution, or simulated quote data.
- OCR sees only pixels currently shown on screen; it cannot read hidden pairs or reconstruct candles not captured.

## Build
JDK 17 + Gradle 8.9:
```bash
gradle --no-daemon :app:assembleDebug
```
