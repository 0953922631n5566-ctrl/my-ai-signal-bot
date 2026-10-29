package com.aisignalradar.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.Executors
import java.util.regex.Pattern

class CaptureService : Service() {
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private val network = Executors.newSingleThreadExecutor()
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private var processing = false
    private var lastFrameAt = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        startForeground(42, notification("กำลังเตรียมแชร์หน้าจอ"))
        val code = intent?.getIntExtra("resultCode", 0) ?: 0
        val data = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra("resultData", Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra("resultData")
        }
        if (code == 0 || data == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(code, data)
            startCapture()
        } catch (_: Exception) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun startCapture() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        val width = metrics.widthPixels.coerceAtLeast(1)
        val height = metrics.heightPixels.coerceAtLeast(1)
        val density = metrics.densityDpi

        thread = HandlerThread("otc-screen-reader").also { it.start() }
        handler = Handler(thread!!.looper)
        reader = ImageReader.newInstance(width, height, android.graphics.PixelFormat.RGBA_8888, 2)
        reader!!.setOnImageAvailableListener({ source ->
            val now = System.currentTimeMillis()
            if (processing || now - lastFrameAt < 900) {
                source.acquireLatestImage()?.close()
                return@setOnImageAvailableListener
            }
            val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
            processing = true
            lastFrameAt = now
            recognizeImage(image)
        }, handler)

        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { stopSelf() }
        }, handler)
        virtualDisplay = projection?.createVirtualDisplay(
            "AISignalRadarCapture", width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader!!.surface, null, handler
        )
        updateNotification("อ่านข้อความจากหน้าจอในเครื่อง")
    }

    private fun recognizeImage(image: Image) {
        var bitmap: Bitmap? = null
        try {
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
            bitmap = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
            padded.recycle()
        } catch (_: Exception) {
            image.close()
            processing = false
            return
        }
        image.close()
        val captured = bitmap ?: run { processing = false; return }
        recognizer.process(InputImage.fromBitmap(captured, 0))
            .addOnSuccessListener { result ->
                val price = findPrice(result.text)
                if (price != null) {
                    val prefs = getSharedPreferences("companion", MODE_PRIVATE)
                    val server = prefs.getString("server", "")?.trimEnd('/') ?: ""
                    val token = prefs.getString("token", "") ?: ""
                    val symbol = prefs.getString("symbol", "EURUSD(OTC)") ?: "EURUSD(OTC)"
                    val confidence = if (price.second) 0.90 else 0.70
                    sendPrice(server, token, symbol, price.first, confidence)
                    updateNotification("อ่านราคาได้: \${price.first}")
                } else {
                    updateNotification("ยังอ่านราคาไม่ชัด — ตรวจตำแหน่งกราฟ")
                }
            }
            .addOnFailureListener { updateNotification("อ่าน OCR ไม่สำเร็จ") }
            .addOnCompleteListener {
                captured.recycle()
                processing = false
            }
    }

    private fun findPrice(text: String): Pair<Double, Boolean>? {
        val pattern = Pattern.compile("(?<!\\\\d)(\\\\d{1,3}(?:[.,]\\\\d{3,5})|\\\\d+[.,]\\\\d{3,6})(?!\\\\d)")
        val matcher = pattern.matcher(text)
        val candidates = mutableListOf<String>()
        while (matcher.find()) candidates.add(matcher.group())
        if (candidates.isEmpty()) return null
        // Decimal-looking text is only a heuristic; OCR cannot reliably identify the broker price label.
        val raw = candidates.maxByOrNull { it.length } ?: return null
        val normalized = if (raw.count { it == '.' || it == ',' } > 1) raw.replace(",", "")
            else if (raw.contains(',') && !raw.contains('.')) raw.replace(',', '.')
            else raw
        val value = normalized.toDoubleOrNull() ?: return null
        if (value <= 0 || value > 1000000) return null
        return Pair(value, raw.length >= 6)
    }

    private fun sendPrice(server: String, token: String, symbol: String, price: Double, confidence: Double) {
        if (!server.startsWith("https://") || token.isBlank()) return
        network.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = URL("$server/api/otc/capture").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Authorization", "Bearer $token")
                val payload = JSONObject().apply {
                    put("symbol", symbol)
                    put("price", price)
                    put("confidence", confidence)
                    put("capturedAt", Instant.now().toString())
                }.toString()
                connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                connection.inputStream.use { it.readBytes() }
            } catch (_: Exception) {
                updateNotification("ส่งข้อมูลไม่ได้ — ตรวจ URL, Token และอินเทอร์เน็ต")
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel("otc_capture", "OTC Screen Reader", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(text: String): Notification =
        NotificationCompat.Builder(this, "otc_capture")
            .setContentTitle("AI Signal Radar Companion")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(42, notification(text))
    }

    override fun onDestroy() {
        virtualDisplay?.release()
        reader?.close()
        projection?.stop()
        thread?.quitSafely()
        network.shutdownNow()
        super.onDestroy()
    }
}
