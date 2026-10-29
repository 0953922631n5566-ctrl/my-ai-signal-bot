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
        private const val CHANNEL = "screen_capture"
        private const val NOTIFICATION_ID = 7001
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var server = ""
    private var token = ""
    private var symbol = "EUR/USD"
    private var lastCaptureElapsed = 0L
    private var lastSendElapsed = 0L
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

    private fun runOcr(bitmap: Bitmap) {
        recognizer.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { result ->
                val candidates = Regex("""(?<![\d])(\d{1,3}(?:,\d{3})*\.\d{4,6}|\d+\.\d{4,6})(?![\d])""")
                    .findAll(result.text)
                    .mapNotNull { it.groupValues[1].replace(",", "").toDoubleOrNull() }
                    .filter { it > 0 }
                    .distinct()
                    .toList()

                // Conservative heuristic only: send a tick when exactly one price-like
                // number exists. This is NOT an ML Kit confidence score and can still misread.
                if (candidates.size == 1 &&
                    SystemClock.elapsedRealtime() - lastSendElapsed >= 850) {
                    lastSendElapsed = SystemClock.elapsedRealtime()
                    sendTick(candidates[0], 0.80)
                }
            }
            .addOnFailureListener { e -> Log.w("SignalRadar", "OCR failed", e) }
            .addOnCompleteListener {
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
                if (code !in 200..299) Log.w("SignalRadar", "Ingest rejected HTTP $code")
            } catch (e: Exception) {
                Log.w("SignalRadar", "Ingest failed", e)
            } finally {
                connection?.disconnect()
            }
        }
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
