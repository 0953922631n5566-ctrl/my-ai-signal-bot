package com.aisignalradar.screencompanion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ScreenCaptureService : Service() {
    companion object {
        const val ACTION_START = "com.aisignalradar.screencompanion.START"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "resultData"
        const val EXTRA_SERVER = "server"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_SYMBOL = "symbol"
        const val EXTRA_ROI = "roi"
        private const val CHANNEL = "screen_capture"
        private const val NOTIFICATION_ID = 7001
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var server = ""
    private var token = ""
    private var symbol = "EUR/USD"
    private var roi = "0,0,100,100"
    private var lastCaptureElapsed = 0L
    private var lastSendElapsed = 0L
    private var lastOcrNoticeElapsed = 0L
    private val busy = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    private val captureLoop = object : Runnable {
        override fun run() {
            if (projection == null) return
            try {
                imageReader?.acquireLatestImage()?.use { image ->
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastCaptureElapsed >= 900 && busy.compareAndSet(false, true)) {
                        lastCaptureElapsed = now
                        val plane = image.planes[0]
                        val pixelStride = plane.pixelStride
                        val rowStride = plane.rowStride
                        val rowPadding = rowStride - pixelStride * image.width
                        val padded = Bitmap.createBitmap(
                            image.width + rowPadding / pixelStride,
                            image.height,
                            Bitmap.Config.ARGB_8888
                        )
                        padded.copyPixelsFromBuffer(plane.buffer)
                        val bitmap = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
                        padded.recycle()
                        runOcr(bitmap)
                    }
                }
            } catch (e: Exception) {
                Log.w("SignalRadar", "Capture frame failed", e)
                busy.set(false)
            }
            mainHandler.postDelayed(this, 200)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START) return START_NOT_STICKY
        server = intent.getStringExtra(EXTRA_SERVER).orEmpty()
        token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
        symbol = intent.getStringExtra(EXTRA_SYMBOL).orEmpty().ifBlank { "EUR/USD" }
        roi = intent.getStringExtra(EXTRA_ROI).orEmpty().ifBlank { "0,0,100,100" }

        startForeground(NOTIFICATION_ID, buildNotification("กำลังจับภาพหน้าจอที่คุณอนุญาต"))
        val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(EXTRA_DATA)
        }
        if (data == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = manager.getMediaProjection(resultCode, data)
        startProjection()
        return START_NOT_STICKY
    }

    private fun startProjection() {
        val p = projection ?: return
        val metrics = resources.displayMetrics
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val density = metrics.densityDpi
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                mainHandler.removeCallbacks(captureLoop)
                releaseCapture()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }, mainHandler)
        virtualDisplay = p.createVirtualDisplay(
            "SignalRadarScreen",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null,
            mainHandler
        )
        mainHandler.post(captureLoop)
    }

    private fun cropToRoi(source: Bitmap): Bitmap {
        val values = roi.split(",").mapNotNull { it.trim().toFloatOrNull() }
        if (values.size != 4) return source
        val left = (source.width * values[0] / 100f).toInt().coerceIn(0, source.width - 1)
        val top = (source.height * values[1] / 100f).toInt().coerceIn(0, source.height - 1)
        val width = (source.width * values[2] / 100f).toInt().coerceAtLeast(1)
            .coerceAtMost(source.width - left)
        val height = (source.height * values[3] / 100f).toInt().coerceAtLeast(1)
            .coerceAtMost(source.height - top)
        if (left == 0 && top == 0 && width == source.width && height == source.height) return source
        return Bitmap.createBitmap(source, left, top, width, height)
    }

    private fun runOcr(bitmap: Bitmap) {
        val scanBitmap = cropToRoi(bitmap)
        recognizer.process(InputImage.fromBitmap(scanBitmap, 0))
            .addOnSuccessListener { result ->
                val candidates = Regex("""(?<![\d])(\d{1,3}(?:,\d{3})*\.(\d{5,6})|\d+\.(\d{5,6}))(?![\d])""")
                    .findAll(result.text)
                    .mapNotNull { it.groupValues[1].replace(",", "").toDoubleOrNull() }
                    // EUR/USD sanity filter; this is not sufficient to identify the live quote.
                    .filter { it in 0.5..2.0 }
                    .distinct()
                    .toList()

                // Never guess when the selected screen region contains multiple prices.
                if (candidates.size == 1 &&
                    SystemClock.elapsedRealtime() - lastSendElapsed >= 850) {
                    lastSendElapsed = SystemClock.elapsedRealtime()
                    updateNotification("อ่าน EUR/USD ได้ " + String.format(java.util.Locale.US, "%.6f", candidates[0]) + " · กำลังส่ง")
                    sendTick(candidates[0], 0.80)
                } else if (SystemClock.elapsedRealtime() - lastOcrNoticeElapsed >= 5000) {
                    lastOcrNoticeElapsed = SystemClock.elapsedRealtime()
                    val message = if (candidates.isEmpty()) {
                        "OCR ยังไม่พบราคา EUR/USD 5–6 หลักในพื้นที่ที่เลือก"
                    } else {
                        "พบราคาที่เป็นไปได้ " + candidates.size + " ค่า · กรุณาปรับ ROI ให้แคบลง"
                    }
                    updateNotification(message)
                }
            }
            .addOnFailureListener { e -> Log.w("SignalRadar", "OCR failed", e) }
            .addOnCompleteListener {
                if (scanBitmap !== bitmap) scanBitmap.recycle()
                bitmap.recycle()
                busy.set(false)
            }
    }

    private fun sendTick(price: Double, heuristicConfidence: Double) {
        worker.execute {
            var connection: HttpURLConnection? = null
            try {
                val payload = JSONObject().apply {
                    put("version", 1)
                    put("symbol", symbol)
                    put("price", price)
                    put("capturedAt", Instant.now().toString())
                    put("confidence", heuristicConfidence)
                }
                connection = (URL("$server/api/screen/ingest").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5000
                    readTimeout = 5000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Authorization", "Bearer $token")
                }
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code in 200..299) {
                    updateNotification("ส่งราคา EUR/USD ไป Render สำเร็จ · HTTP " + code)
                } else {
                    Log.w("SignalRadar", "Ingest rejected HTTP " + code)
                    updateNotification("Render ปฏิเสธข้อมูล · HTTP " + code)
                }
            } catch (e: Exception) {
                Log.w("SignalRadar", "Ingest failed", e)
                updateNotification("ส่งข้อมูลไม่สำเร็จ · ตรวจ URL/Token/อินเทอร์เน็ต")
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun updateNotification(message: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(message))
    }

    private fun buildNotification(message: String): Notification {
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Screen capture", NotificationManager.IMPORTANCE_LOW)
            )
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("AI Signal Radar")
            .setContentText(message)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
    }

    private fun releaseCapture() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { projection?.stop() } catch (_: Exception) {}
        projection = null
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(captureLoop)
        releaseCapture()
        try { recognizer.close() } catch (_: Exception) {}
        worker.shutdownNow()
        super.onDestroy()
    }
}
