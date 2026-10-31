# AI SIGNAL RADAR OCR (Android overlay starter)

This Android app requests Android's official MediaProjection consent, captures the visible screen, and uses on-device ML Kit text recognition. It does not log in to 8xTrade, read passwords, place trades, or claim trading signals from OCR text.

## Build
GitHub Actions workflow: **Build Android OCR APK**. Run it manually from Actions or push changes under this directory. Download the artifact named `AI-Signal-Radar-OCR-debug`.

## First-run Android permissions
Android requires the user to grant:
1. Display over other apps.
2. Screen capture consent (Android shows its own system dialog each capture session).
3. Notification permission where required by the Android version.

These prompts cannot safely or legitimately be bypassed. After granting, open the 8xTrade chart; the floating OCR panel displays recognized on-screen text.

## Current scope
This is the OCR capture foundation only. It displays recognized text and is not yet connected to the Render analysis API. Signal generation, candle parsing, and backend integration must be implemented and tested against real screenshots before it can be called a working trading signal app.
