package com.aisignalradar.ocr

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
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
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class CaptureService : Service() {
    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        private const val CHANNEL = "ocr_capture"
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var overlay: LinearLayout? = null
    private var output: TextView? = null
    private var windowManager: WindowManager? = null
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private var busy = false
    private var firstFrameReceived = false
    @Volatile private var lastOcrUploadAt = 0L
    private lateinit var workerThread: HandlerThread
    private lateinit var worker: Handler

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            stopSelf()
        }
    }

    override fun onCreate() {
        super.onCreate()
        workerThread = HandlerThread("ocr-worker").apply { start() }
        worker = Handler(workerThread.looper)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(7, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            } else {
                startForeground(7, notification())
            }

            if (intent == null || !Settings.canDrawOverlays(this)) {
                stopSelf()
                return START_NOT_STICKY
            }

            val code = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
            val data = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(EXTRA_RESULT_DATA)
            }
            if (data == null) {
                stopSelf()
                return START_NOT_STICKY
            }

            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            projection = manager.getMediaProjection(code, data)
            val activeProjection = projection ?: run {
                stopSelf()
                return START_NOT_STICKY
            }

            // Android 14+ requires a callback to be registered before createVirtualDisplay().
            activeProjection.registerCallback(projectionCallback, worker)
            showOverlay()
            startCapture()
        } catch (e: Exception) {
            output?.post { output?.text = "เริ่มจับภาพไม่สำเร็จ: ${e.javaClass.simpleName} ${e.message ?: ""}" }
            stopSelf()
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    private fun startCapture() {
        val metrics = resources.displayMetrics
        output?.post { output?.text = "กำลังเตรียมรับภาพหน้าจอ..." }
        reader = ImageReader.newInstance(metrics.widthPixels, metrics.heightPixels, PixelFormat.RGBA_8888, 3)
        reader?.setOnImageAvailableListener({ source ->
            val image = try {
                source.acquireLatestImage()
            } catch (e: Exception) {
                output?.post { output?.text = "รับภาพไม่สำเร็จ: ${e.javaClass.simpleName}" }
                null
            } ?: return@setOnImageAvailableListener

            if (busy) {
                image.close()
                return@setOnImageAvailableListener
            }
            busy = true
            if (!firstFrameReceived) {
                firstFrameReceived = true
                output?.post { output?.text = "ได้รับภาพหน้าจอแล้ว • กำลังอ่านข้อความ..." }
            }
            recognize(image)
        }, worker)

        display = projection?.createVirtualDisplay(
            "AISignalOCR",
            metrics.widthPixels,
            metrics.heightPixels,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader?.surface,
            null,
            worker
        )
        if (display == null) {
            output?.post { output?.text = "สร้างจอจับภาพไม่สำเร็จ • กรุณาหยุดแล้วเริ่มใหม่" }
        }
    }

    private fun recognize(image: Image) {
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val pixelStride = plane.pixelStride
            val rowStride = plane.rowStride
            val rowPadding = rowStride - pixelStride * image.width
            val bitmap = android.graphics.Bitmap.createBitmap(
                image.width + rowPadding / pixelStride,
                image.height,
                android.graphics.Bitmap.Config.ARGB_8888
            )
            bitmap.copyPixelsFromBuffer(buffer)
            val cropped = android.graphics.Bitmap.createBitmap(bitmap, 0, 0, image.width, image.height)
            image.close()
            recognizer.process(InputImage.fromBitmap(cropped, 0))
                .addOnSuccessListener { result ->
                    val text = result.text.lineSequence().take(12).joinToString("\n")
                    output?.post {
                        output?.text = if (text.isBlank()) {
                            "ได้รับภาพแล้ว แต่ยังไม่พบตัวอักษร\nลองขยับกราฟให้ชัดและไม่ถูกหน้าต่างบัง"
                        } else {
                            "อ่านข้อความได้แล้ว ✓\n$text"
                        }
                    }
                    if (text.isNotBlank()) parseAndUpload(text)
                }
                .addOnFailureListener { error ->
                    output?.post { output?.text = "ML Kit อ่านภาพไม่สำเร็จ: ${error.javaClass.simpleName} ${error.message ?: ""}" }
                }
                .addOnCompleteListener {
                    cropped.recycle()
                    bitmap.recycle()
                    busy = false
                }
        } catch (error: Exception) {
            try { image.close() } catch (_: Exception) { }
            output?.post { output?.text = "ประมวลผลภาพผิดพลาด: ${error.javaClass.simpleName} ${error.message ?: ""}" }
            busy = false
        }
    }

    // Extract only structured market fields. The screenshot and full OCR text stay on-device.
    private fun parseAndUpload(ocrText: String) {
        val now = System.currentTimeMillis()
        if (now - lastOcrUploadAt < 3000) return

        val pairMatch = Regex("""(?i)\b([A-Z]{3})\s*/\s*([A-Z]{3})\b""").find(ocrText)
            ?: return
        val symbol = pairMatch.groupValues[1].uppercase() + "/" + pairMatch.groupValues[2].uppercase()
        // Confirm OTC only when the selected pair is visibly labelled OTC.
        // Mixed tabs or unclear market labels remain unconfirmed.
        val pairPattern = Regex("(?i)" + Regex.escape(symbol).replace("/", "\\\\s*/\\\\s*") + "\\\\s*\\\\(OTC\\\\)")
        val marketType = when {
            pairPattern.containsMatchIn(ocrText) -> "OTC"
            Regex("""(?i)\\bDIGITAL\\b""").containsMatchIn(ocrText) &&
                !Regex("""(?i)\\bOTC\\b""").containsMatchIn(ocrText) -> "DIGITAL"
            else -> "UNCONFIRMED"
        }
        val prices = Regex("""(?<![\d.])\d{1,3}\.\d{3,6}(?!\d)""")
            .findAll(ocrText)
            .mapNotNull { it.value.toDoubleOrNull() }
            .distinct()
            .take(8)
            .toList()
        val countdown = Regex("""\b\d{1,2}:\d{2}\b""").find(ocrText)?.value

        val payload = JSONObject().apply {
            put("symbol", symbol)
            put("marketType", marketType)
            put("priceCandidates", JSONArray(prices))
            put("countdown", countdown ?: JSONObject.NULL)
            put("capturedAt", now)
        }
        lastOcrUploadAt = now

        Thread({
            var connection: HttpURLConnection? = null
            try {
                connection = (URL("https://my-ai-signal-bot-v2.onrender.com/api/ocr-system/ingest").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5000
                    readTimeout = 5000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Accept", "application/json")
                }
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code in 200..299) {
                    output?.post {
                        val old = output?.text?.toString().orEmpty()
                        output?.text = old + "\nส่งข้อมูลคู่เงิน " + symbol + " เข้า AI Radar แล้ว ✓"
                    }
                } else {
                    output?.post { output?.text = "ส่งข้อมูลเข้า AI Radar ไม่สำเร็จ (HTTP " + code + ")" }
                }
            } catch (e: Exception) {
                output?.post { output?.text = "เชื่อมต่อ AI Radar ไม่ได้: " + (e.message ?: e.javaClass.simpleName) }
            } finally {
                connection?.disconnect()
            }
        }, "ocr-upload").start()
    }

    private fun showOverlay() {
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(18, 14, 18, 14)
            setBackgroundColor(0xEE111D2B.toInt())
        }
        val header = TextView(this).apply {
            text = "AI RADAR OCR   •   แตะหยุดเพื่อปิด"
            textSize = 13f
            setTextColor(0xFF42D9FF.toInt())
            setOnClickListener { stopSelf() }
        }
        output = TextView(this).apply {
            text = "กำลังเริ่มอ่านหน้าจอ..."
            textSize = 12f
            setTextColor(0xFFFFFFFF.toInt())
            maxLines = 12
        }
        root.addView(header)
        root.addView(output)
        overlay = root
        val type = if (Build.VERSION.SDK_INT >= 26) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val params = WindowManager.LayoutParams(
            300,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            y = 100
        }
        windowManager?.addView(root, params)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "OCR screen reading", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL)
        } else {
            Notification.Builder(this)
        }
        return builder.setContentTitle("AI SIGNAL RADAR OCR")
            .setContentText("กำลังอ่านหน้าจอเมื่อได้รับอนุญาต")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .build()
    }

    override fun onDestroy() {
        try {
            overlay?.let { windowManager?.removeView(it) }
        } catch (_: Exception) {
        }
        projection?.unregisterCallback(projectionCallback)
        display?.release()
        reader?.close()
        projection?.stop()
        recognizer.close()
        if (::workerThread.isInitialized) workerThread.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
