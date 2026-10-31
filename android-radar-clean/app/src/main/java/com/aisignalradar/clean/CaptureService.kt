package com.aisignalradar.clean

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
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.WindowManager
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.regex.Pattern

class CaptureService : Service() {
    private var projection: MediaProjection? = null
    private var reader: ImageReader? = null
    private var virtualDisplay: VirtualDisplay? = null
    private val busy = AtomicBoolean(false)
    private var lastFrameAt = 0L
    private var screenWidth = 0
    private var screenHeight = 0
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else {
            @Suppress("DEPRECATION")
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }
        if (resultCode == 0 || data == null) { stopSelf(); return START_NOT_STICKY }
        startForeground(NOTIFICATION_ID, makeNotification())
        startCapture(resultCode, data)
        return START_NOT_STICKY
    }

    private fun makeNotification(): Notification {
        val channelId = "ocr_capture"
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(
            NotificationChannel(channelId, "OCR screen capture", NotificationManager.IMPORTANCE_LOW)
        )
        return if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channelId)
            .setContentTitle("AI Signal Radar OCR").setContentText("กำลังอ่านหน้าจอที่คุณอนุญาต")
            .setSmallIcon(android.R.drawable.ic_menu_view).setOngoing(true).build()
        else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setContentTitle("AI Signal Radar OCR")
                .setContentText("กำลังอ่านหน้าจอ").setSmallIcon(android.R.drawable.ic_menu_view).build()
        }
    }

    private fun startCapture(resultCode: Int, data: Intent) {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = manager.getMediaProjection(resultCode, data)
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
        screenWidth = metrics.widthPixels
        screenHeight = metrics.heightPixels
        reader = ImageReader.newInstance(screenWidth, screenHeight, PixelFormat.RGBA_8888, 3)
        reader?.setOnImageAvailableListener({ imageReader ->
            val frame = imageReader.acquireLatestImage() ?: return@setOnImageAvailableListener
            val now = SystemClock.elapsedRealtime()
            if (now - lastFrameAt < MIN_FRAME_INTERVAL_MS || !busy.compareAndSet(false, true)) {
                frame.close()
                return@setOnImageAvailableListener
            }
            lastFrameAt = now
            processFrame(frame)
        }, null)
        projection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { stopSelf() }
        }, null)
        virtualDisplay = projection?.createVirtualDisplay(
            "AIRadarOCRClean", screenWidth, screenHeight, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader?.surface, null, null
        )
    }

    private fun processFrame(frame: Image) {
        var bitmap: Bitmap? = null
        try {
            bitmap = imageToBitmap(frame)
            frame.close()
            recognizer.process(InputImage.fromBitmap(bitmap, 0))
                .addOnSuccessListener { result -> publishRecognizedText(result) }
                .addOnFailureListener { error -> publishError(error.localizedMessage ?: "OCR error") }
                .addOnCompleteListener {
                    bitmap?.recycle()
                    busy.set(false)
                }
        } catch (error: Exception) {
            try { frame.close() } catch (_: Exception) { }
            bitmap?.recycle()
            busy.set(false)
            publishError(error.localizedMessage ?: "Frame error")
        }
    }

    private fun imageToBitmap(image: Image): Bitmap {
        val plane = image.planes[0]
        val paddedWidth = image.width + (plane.rowStride - plane.pixelStride * image.width) / plane.pixelStride
        val padded = Bitmap.createBitmap(paddedWidth, image.height, Bitmap.Config.ARGB_8888)
        padded.copyPixelsFromBuffer(plane.buffer)
        val cropped = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
        padded.recycle()
        return cropped
    }

    private data class NumericCandidate(val value: String, val x: Int, val y: Int, val text: String)

    private fun publishRecognizedText(result: Text) {
        val rawText = result.text
        val normalized = rawText.replace('\n', ' ')
        val pairMatcher = Pattern.compile("(?i)\\b[A-Z]{3}\\s*[/\\-]\\s*[A-Z]{3}\\b").matcher(normalized)
        val pair = if (pairMatcher.find()) pairMatcher.group().replace(" ", "").uppercase(Locale.US) else "NOT_FOUND"
        val market = when {
            Regex("(?i)\\bOTC\\b").containsMatchIn(normalized) -> "OTC"
            Regex("(?i)\\bMAIN\\b|\\bSPOT\\b|\\bFOREX\\b").containsMatchIn(normalized) -> "MAIN"
            else -> "UNKNOWN"
        }
        val timeMatcher = Pattern.compile("\\b(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?\\b").matcher(normalized)
        val clock = if (timeMatcher.find()) timeMatcher.group() else "NOT_FOUND"

        // Deliberately reject grouped numbers such as account balance 10,000.00.
        // This is a candidate extractor only: screen-wide OCR cannot prove which
        // decimal belongs to the active quote without platform-specific ROI validation.
        val pricePattern = Pattern.compile("(?<![\\d,.])\\d{1,3}\\.\\d{2,6}(?![\\d])")
        val candidates = mutableListOf<NumericCandidate>()
        result.textBlocks.forEach { block ->
            block.lines.forEach { line ->
                val box = line.boundingBox
                val matcher = pricePattern.matcher(line.text)
                while (matcher.find() && candidates.size < 12) {
                    val x = box?.centerX() ?: -1
                    val y = box?.centerY() ?: -1
                    candidates.add(NumericCandidate(matcher.group(), x, y, line.text))
                }
            }
        }
        val price = if (candidates.size == 1) "CANDIDATE: ${candidates.first().value}" else "UNCONFIRMED (${candidates.size} candidates)"
        val diagnostics = candidates.joinToString("\\n") { candidate ->
            "${candidate.value} @ ${candidate.x},${candidate.y} | ${candidate.text}"
        }.ifBlank { "ไม่พบตัวเลขทศนิยมที่เข้าเงื่อนไข" }

        val output = Intent(ACTION_OCR_RESULT).setPackage(packageName).apply {
            putExtra("pair", pair)
            putExtra("market", market)
            putExtra("price", price)
            putExtra("clock", clock)
            putExtra("raw", rawText.take(2600))
            putExtra("candidates", diagnostics.take(1800))
            putExtra("screen_width", screenWidth)
            putExtra("screen_height", screenHeight)
        }
        sendBroadcast(output)
    }

    private fun publishError(message: String) {
        sendBroadcast(Intent(ACTION_OCR_RESULT).setPackage(packageName).putExtra("raw", "OCR: $message"))
    }

    override fun onDestroy() {
        reader?.setOnImageAvailableListener(null, null)
        virtualDisplay?.release()
        reader?.close()
        projection?.stop()
        recognizer.close()
        super.onDestroy()
    }

    companion object {
        const val ACTION_OCR_RESULT = "com.aisignalradar.clean.OCR_RESULT"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        private const val NOTIFICATION_ID = 501
        private const val MIN_FRAME_INTERVAL_MS = 900L
    }
}
