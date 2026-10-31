package com.signalsradar.capture

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

class CaptureService : Service() {
    companion object {
        const val ACTION_START = "com.signalsradar.capture.START"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_MARKET = "market"
        const val EXTRA_PAIR = "pair"
        const val EXTRA_OTC = "otc"
        private const val CHANNEL = "screen_capture"
        private const val NOTIFICATION_ID = 71
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private var endpoint = ""
    private var auth = ""
    private var selectedMarket = "MAIN"
    private var selectedPair = "EUR/USD"
    private var otcConfirmed = false
    private var width = 720
    private var height = 1280
    private var density = 1
    private val captureLoop = object : Runnable {
        override fun run() {
            captureAndUpload()
            handler.postDelayed(this, 5000)
        }
    }

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START) return START_NOT_STICKY
        endpoint = intent.getStringExtra(EXTRA_URL).orEmpty().trimEnd('/') + "/api/ocr/frame"
        auth = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        selectedMarket = intent.getStringExtra(EXTRA_MARKET) ?: "MAIN"
        selectedPair = intent.getStringExtra(EXTRA_PAIR) ?: "EUR/USD"
        otcConfirmed = intent.getBooleanExtra(EXTRA_OTC, false)
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val data = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        if (data == null || resultCode != Activity.RESULT_OK) { stopSelf(); return START_NOT_STICKY }
        createNotification()
        beginProjection(resultCode, data)
        return START_NOT_STICKY
    }

    private fun createNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "AI Signal Radar screen capture", NotificationManager.IMPORTANCE_LOW)
        )
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("AI Signal Radar กำลังอ่านหน้าจอ")
            .setContentText("$selectedMarket · $selectedPair · ส่งภาพทุก 5 วินาที")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true).build()
        startForeground(NOTIFICATION_ID, n)
    }

    private fun beginProjection(resultCode: Int, data: Intent) {
        try {
            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealMetrics(metrics)
            val scale = minOf(1f, 900f / max(metrics.widthPixels, metrics.heightPixels).toFloat())
            width = (metrics.widthPixels * scale).toInt().coerceAtLeast(1)
            height = (metrics.heightPixels * scale).toInt().coerceAtLeast(1)
            density = metrics.densityDpi
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(resultCode, data)
            projection?.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() { stopSelf() }
            }, handler)
            display = projection?.createVirtualDisplay(
                "SignalRadarCapture", width, height, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader?.surface, null, handler
            )
            handler.post(captureLoop)
        } catch (e: Exception) { stopSelf() }
    }

    private fun captureAndUpload() {
        if (!busy.compareAndSet(false, true)) return
        executor.execute {
            try {
                val img = reader?.acquireLatestImage() ?: return@execute
                val bitmap: Bitmap
                try {
                    val plane = img.planes[0]
                    val pixelStride = plane.pixelStride
                    val rowStride = plane.rowStride
                    val rowPadding = rowStride - pixelStride * width
                    val padded = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888)
                    padded.copyPixelsFromBuffer(plane.buffer)
                    bitmap = Bitmap.createBitmap(padded, 0, 0, width, height)
                    padded.recycle()
                } finally { img.close() }
                try {
                    val bytes = ByteArrayOutputStream().use { out ->
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 65, out); out.toByteArray()
                    }
                    bitmap.recycle()
                    val encoded = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    val body = JSONObject().apply {
                        put("market", selectedMarket); put("symbol", selectedPair)
                        put("otcConfirmed", otcConfirmed); put("timestamp", System.currentTimeMillis())
                        put("image", "data:image/jpeg;base64,$encoded")
                    }.toString().toByteArray(Charsets.UTF_8)
                    val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                        requestMethod = "POST"; connectTimeout = 12000; readTimeout = 20000
                        doOutput = true; setRequestProperty("Content-Type", "application/json")
                        setRequestProperty("x-screen-token", auth)
                    }
                    try {
                        conn.outputStream.use { it.write(body) }
                        val code = conn.responseCode
                        (if (code in 200..299) conn.inputStream else conn.errorStream)?.close()
                    } finally { conn.disconnect() }
                } finally { }
            } catch (_: Exception) {
                // A temporary network/OCR failure is retried on the next screen frame.
            } finally { busy.set(false) }
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(captureLoop)
        try { display?.release(); reader?.close(); projection?.stop() } catch (_: Exception) {}
        executor.shutdownNow()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
