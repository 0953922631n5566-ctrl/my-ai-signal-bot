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
            output?.text = "เริ่มจับภาพไม่สำเร็จ: ${e.javaClass.simpleName}"
            stopSelf()
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    private fun startCapture() {
        val metrics = resources.displayMetrics
        reader = ImageReader.newInstance(metrics.widthPixels, metrics.heightPixels, PixelFormat.RGBA_8888, 2)
        reader?.setOnImageAvailableListener({ source ->
            val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
            if (busy) {
                image.close()
                return@setOnImageAvailableListener
            }
            busy = true
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
                    output?.post { output?.text = if (text.isBlank()) "กำลังอ่านหน้าจอ..." else text }
                }
                .addOnFailureListener {
                    output?.post { output?.text = "อ่านภาพไม่สำเร็จ ลองปรับกราฟให้ชัดขึ้น" }
                }
                .addOnCompleteListener {
                    cropped.recycle()
                    bitmap.recycle()
                    busy = false
                }
        } catch (_: Exception) {
            image.close()
            busy = false
        }
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
