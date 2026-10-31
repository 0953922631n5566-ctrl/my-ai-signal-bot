# AI SIGNAL RADAR OCR — Handoff (2026-10-31)

## Change delivered to branch
Branch: `dual-system-independent`

The Android launcher activity has been changed from a settings-only screen to a single APK shell containing the dashboard UI. Dashboard HTML, CSS, and JavaScript are bundled under:
- `android-capture/app/src/main/assets/index.html`
- `android-capture/app/src/main/assets/styles.css`
- `android-capture/app/src/main/assets/app.js`

The APK uses AndroidX WebKit's `WebViewAssetLoader` to serve bundled assets on the appassets HTTPS origin. The JavaScript bridge exposes only the configured backend base URL; it does not expose the screen-ingest token to JavaScript.

## Android controls
- Top bar: Settings, Start screen reading, Stop.
- Settings persist Render HTTPS URL, SCREEN_INGEST_TOKEN, market, pair, and OTC confirmation in app-private SharedPreferences.
- Start screen reading still requests Android MediaProjection consent and starts the existing foreground CaptureService.
- CaptureService continues to upload screen frames to `/api/ocr/frame`; no broker login or automatic order placement was added.

## Dashboard behavior
The existing dual-system dashboard is bundled into the APK. Its API helper resolves backend API paths against the Render URL provided by the native bridge. The web dashboard remains available separately as before.

## Build
GitHub Actions workflow: `.github/workflows/build-android-apk.yml`
A push to this branch touching `android-capture/**` triggered the debug APK workflow. Build run #11 completed successfully on 2026-10-31. Artifact: `ai-signal-radar-capture-debug` (1,237,791-byte ZIP containing `app-debug.apk`; APK size 1,269,067 bytes). Version: 1.1.0 / versionCode 3.

## Important verification limits
- A source commit is not proof that the APK compiled. Check the GitHub Actions run and download the artifact only after the workflow succeeds.
- The APK dashboard UI integration does not itself fix OCR recognition quality. Prior Render logs showed OCR price parsing failures; validate with a clear chart screenshot and confirm the backend accepts a single unambiguous price candidate.
- Android native capture settings choose the market/pair used in uploaded frames. Match those settings to the chart shown on screen.
- `dual-system/server.js` now allowlists CORS requests from `https://appassets.androidplatform.net` for GET/POST/OPTIONS and the Content-Type/x-screen-token headers. Render service `ai-signal-radar-dual` deployed commit `86b1b7505412e57d5d28d8b4229485ba0bb85c68` successfully (status live). If the dashboard still shows API/network errors on a device, inspect the Android WebView console and actual device connectivity.
- Never put secrets in GitHub source files. Keep SCREEN_INGEST_TOKEN in app-private settings and Render environment variables.


## Build artifact note
The APK was extracted from the successful GitHub Actions artifact and verified to contain `assets/index.html`, `assets/styles.css`, and `assets/app.js`. This confirms the dashboard files are packaged inside the APK; it does not by itself prove OCR accuracy on a user's trading chart.

## User install / setup checklist for APK v1.1.0
1. Install the APK build artifact from GitHub Actions run #11 (artifact ZIP: `ai-signal-radar-capture-debug`; install the `app-debug.apk` inside the ZIP).
2. Open **AI SIGNAL RADAR OCR**.
3. Open **ตั้งค่า**.
4. Render URL: `https://ai-signal-radar-dual.onrender.com`.
5. Enter the existing `SCREEN_INGEST_TOKEN` value from the Render service environment. Do not paste this secret into GitHub, source code, chat, or handoff documents.
6. Choose `MAIN` for the regular market and select the same currency pair that is currently visible on the broker chart. Only choose OTC when the displayed chart is actually OTC and confirm the OTC checkbox.
7. Tap **บันทึก**.
8. Tap **เริ่มอ่านหน้าจอ** and approve Android's screen-capture permission prompt.
9. Open the trading chart and keep the relevant pair/market visible. Return to the app to inspect dashboard status. Tap **หยุด** when finished.

If Android refuses an update due to a signing mismatch, do not uninstall the older app until its settings/token are safely noted. Reinstalling can erase app-private settings.

## Current state and next work
- APK dashboard is bundled and GitHub Actions build #11 succeeded.
- Backend CORS change for the APK's local asset origin deployed successfully to Render.
- User still needs to install and test this build on their Android phone.
- Next verification: confirm dashboard loads, backend status endpoints respond, screen capture permission starts, frames arrive at `/api/ocr/frame`, and OCR extracts the actual chart price (not just timer/countdown). Capture a sample chart screenshot if OCR still rejects the price.
- Do not claim OCR or signal accuracy is verified until a real chart capture has been tested end-to-end.

## Mandatory handoff rule for all future work
After **every** code/configuration change or project action, update this file (and the changelog below) before finishing the task. Record:
- Date/time (Thailand time), branch, commit SHA, and exact files changed.
- What changed and why; any settings, environment variables, or permissions affected.
- Build/deploy run IDs and final status (success/failure/in progress).
- Exact files/artifacts the user must install or download, with working links when available.
- Exact steps the user must perform, in order; explicitly say when no user action is needed.
- What was actually tested, what was not tested, known errors, and the next concrete task for the next chat.
- Never record secret values. Record only the variable name and where the user can obtain/set it.
- Keep this document self-contained so a new chat can continue without asking the user to repeat information. Also update the project README or relevant task-specific doc when that improves discoverability.

## Changelog
### 2026-10-31 — APK dashboard integration and handoff
- Bundled the dashboard assets into the Android APK and replaced the settings-only launcher with a dashboard WebView plus native settings/capture controls.
- Added CORS allowlist for the appassets origin to the dual-system API server.
- GitHub Actions run #11 succeeded; APK artifact name: `ai-signal-radar-capture-debug`.
- Render deployment for commit `86b1b7505412e57d5d28d8b4229485ba0bb85c68` reached `live`.
- User action still required: install APK and perform end-to-end screen/OCR test using the checklist above.
