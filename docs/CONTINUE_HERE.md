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
A push to this branch touching `android-capture/**` should trigger the debug APK workflow.
Artifact name configured: `ai-signal-radar-capture-debug`

## Important verification limits
- A source commit is not proof that the APK compiled. Check the GitHub Actions run and download the artifact only after the workflow succeeds.
- The APK dashboard UI integration does not itself fix OCR recognition quality. Prior Render logs showed OCR price parsing failures; validate with a clear chart screenshot and confirm the backend accepts a single unambiguous price candidate.
- Android native capture settings choose the market/pair used in uploaded frames. Match those settings to the chart shown on screen.
- The backend must permit API requests from the appassets origin (CORS). If the dashboard shows API/network errors, inspect the server's CORS configuration and Android WebView console before declaring it operational.
- Never put secrets in GitHub source files. Keep SCREEN_INGEST_TOKEN in app-private settings and Render environment variables.
