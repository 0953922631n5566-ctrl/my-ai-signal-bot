package com.aisignalradar.clean

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.graphics.Rect
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
    private val manualScanRequested = AtomicBoolean(false)
    private var lastLivePriceX = -1
    private var lastLivePriceY = -1
    private var screenWidth = 0
    private var screenHeight = 0
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_MANUAL_SCAN) {
            manualScanRequested.set(true)
            return START_STICKY
        }
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
            val manual = manualScanRequested.get()
            if ((!manual && now - lastFrameAt < MIN_FRAME_INTERVAL_MS) || !busy.compareAndSet(false, true)) {
                frame.close()
                return@setOnImageAvailableListener
            }
            if (manual) manualScanRequested.set(false)
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
                .addOnSuccessListener { result -> publishRecognizedText(result, bitmap) }
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

    private data class NumericCandidate(
        val value: String,
        val x: Int,
        val y: Int,
        val text: String,
        val decimals: Int
    )

    private fun detectOrangePriceBadge(bitmap: Bitmap): Rect? {
        // HSV-based orange tag detection adapted from the supplied OpenCV algorithm.
        // User-provided Xiaomi 11T crop: X 82%-100%, Y 15%-90%.
        // Start at 78% instead of exactly 82% to retain the measured badge's
        // left edge (previous diagnostics: x=868 on an approximately 1080px-wide frame).
        // The right edge remains the screen edge; y follows the supplied crop.
        val left = (bitmap.width * 0.78f).toInt().coerceAtLeast(0)
        val right = (bitmap.width * 1.00f).toInt().coerceAtMost(bitmap.width - 1)
        val top = (bitmap.height * 0.15f).toInt().coerceAtLeast(0)
        val bottom = (bitmap.height * 0.90f).toInt().coerceAtMost(bitmap.height - 1)
        val step = 2
        val gridWidth = ((right - left) / step) + 1
        val gridHeight = ((bottom - top) / step) + 1
        if (gridWidth < 2 || gridHeight < 2) return null

        // OpenCV HSV ranges [10,150,150]-[25,255,255].
        // Android RGBToHSV uses hue degrees and saturation/value in 0..1.
        val mask = BooleanArray(gridWidth * gridHeight)
        val hsv = FloatArray(3)
        for (gy in 0 until gridHeight) {
            val y = top + gy * step
            for (gx in 0 until gridWidth) {
                val x = left + gx * step
                val pixel = bitmap.getPixel(x, y)
                android.graphics.Color.RGBToHSV(
                    android.graphics.Color.red(pixel),
                    android.graphics.Color.green(pixel),
                    android.graphics.Color.blue(pixel),
                    hsv
                )
                mask[gy * gridWidth + gx] =
                    hsv[0] in 10f..25f && hsv[1] >= (150f / 255f) && hsv[2] >= (150f / 255f)
            }
        }

        // 3x3 morphological opening (remove isolated noise), then closing
        // (fill tiny gaps) to approximate the supplied OpenCV pipeline.
        fun morphology(source: BooleanArray, dilate: Boolean): BooleanArray {
            val target = BooleanArray(source.size)
            for (y in 1 until gridHeight - 1) {
                for (x in 1 until gridWidth - 1) {
                    var value = !dilate
                    loop@ for (dy in -1..1) {
                        for (dx in -1..1) {
                            val bit = source[(y + dy) * gridWidth + (x + dx)]
                            if (dilate && bit) { value = true; break@loop }
                            if (!dilate && !bit) { value = false; break@loop }
                        }
                    }
                    target[y * gridWidth + x] = value
                }
            }
            return target
        }
        val cleaned = morphology(morphology(morphology(morphology(mask, false), true), true), false)

        // Connected-component scan is the Android-native equivalent of contours.
        // Keep only badge-sized components and choose the largest qualifying one.
        val visited = BooleanArray(cleaned.size)
        val queue = IntArray(cleaned.size)
        var bestCount = 0
        var bestMinX = 0
        var bestMaxX = 0
        var bestMinY = 0
        var bestMaxY = 0
        for (index in cleaned.indices) {
            if (!cleaned[index] || visited[index]) continue
            var head = 0
            var tail = 0
            queue[tail++] = index
            visited[index] = true
            var count = 0
            var minX = gridWidth
            var maxX = 0
            var minY = gridHeight
            var maxY = 0
            while (head < tail) {
                val current = queue[head++]
                val x = current % gridWidth
                val y = current / gridWidth
                count++
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
                for (dy in -1..1) {
                    for (dx in -1..1) {
                        if (dx == 0 && dy == 0) continue
                        val nx = x + dx
                        val ny = y + dy
                        if (nx !in 0 until gridWidth || ny !in 0 until gridHeight) continue
                        val next = ny * gridWidth + nx
                        if (cleaned[next] && !visited[next]) {
                            visited[next] = true
                            queue[tail++] = next
                        }
                    }
                }
            }
            val componentWidth = (maxX - minX + 1) * step
            val componentHeight = (maxY - minY + 1) * step
            val componentArea = count * step * step
            if (componentArea > 100 && componentWidth > 20 && componentHeight > 10 && count > bestCount) {
                bestCount = count
                bestMinX = minX
                bestMaxX = maxX
                bestMinY = minY
                bestMaxY = maxY
            }
        }
        if (bestCount == 0) return null

        val padding = 4
        val boxLeft = (left + bestMinX * step - padding).coerceAtLeast(left)
        val boxTop = (top + bestMinY * step - padding).coerceAtLeast(top)
        val boxRight = (left + (bestMaxX + 1) * step + padding).coerceAtMost(right)
        val boxBottom = (top + (bestMaxY + 1) * step + padding).coerceAtMost(bottom)
        return Rect(boxLeft, boxTop, boxRight, boxBottom)
    }

    private fun publishRecognizedText(result: Text, bitmap: Bitmap) {
        val rawText = result.text
        val normalized = rawText.replace('\n', ' ')
        val pairMatcher = Pattern.compile("(?i)\\b[A-Z]{3}\\s*[/\\-]\\s*[A-Z]{3}\\b").matcher(normalized)
        val pair = if (pairMatcher.find()) pairMatcher.group().replace(" ", "").uppercase(Locale.US) else "NOT_FOUND"
        // ML Kit may merge adjacent letters (e.g. "OTCE Blitz") or split
        // the market badge into separate blocks. Normalize OCR lines and accept
        // the OTC token even when punctuation/neighboring glyphs are attached.
        val normalizedLines = result.textBlocks.flatMap { block ->
            block.lines.map { it.text.uppercase(Locale.US) }
        }
        val otcVisible = normalizedLines.any { line ->
            line.replace(Regex("[^A-Z]"), "").contains("OTC")
        } || normalized.uppercase(Locale.US).replace(Regex("[^A-Z]"), "").contains("OTC")
        val mainVisible = normalizedLines.any { line ->
            Regex("(?i)\\b(MAIN|SPOT|FOREX)\\b").containsMatchIn(line)
        }
        val market = when {
            otcVisible -> "OTC"
            mainVisible -> "MAIN"
            else -> "UNKNOWN"
        }
        val timeMatcher = Pattern.compile("\\b(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?\\b").matcher(normalized)
        val clock = if (timeMatcher.find()) timeMatcher.group() else "NOT_FOUND"

        // Keep all decimal values for diagnostics, but only consider 5-6 decimal
        // quotes in the chart's right-hand live-price lane as live-price candidates.
        // Designed for the observed EUR/USD quote format (e.g. 1.121115).
        val pricePattern = Pattern.compile("(?<![\\d,.])\\d{1,3}\\.\\d{2,6}(?![\\d])")
        val candidates = mutableListOf<NumericCandidate>()
        result.textBlocks.forEach { block ->
            block.lines.forEach { line ->
                val box = line.boundingBox
                val matcher = pricePattern.matcher(line.text)
                while (matcher.find() && candidates.size < 20) {
                    val value = matcher.group()
                    val decimals = value.substringAfter('.', "").length
                    candidates.add(
                        NumericCandidate(value, if (box != null && line.text.isNotEmpty()) box.left + (((matcher.start() + matcher.end()) / 2f / line.text.length) * box.width()).toInt() else -1, box?.centerY() ?: -1, line.text, decimals)
                    )
                }
            }
        }

        // Detect the moving orange current-price badge from screen pixels on every OCR frame.
        val badge = detectOrangePriceBadge(bitmap)
        val badgeCandidates = if (badge != null) candidates.filter { candidate ->
            candidate.decimals in 5..6 && candidate.x in (badge.left - 12)..(badge.right + 12) &&
                candidate.y in (badge.top - 12)..(badge.bottom + 12)
        } else emptyList()
        val selectedLive = when {
            badgeCandidates.size == 1 -> badgeCandidates.first()
            badgeCandidates.size > 1 && lastLivePriceX >= 0 -> {
                val ranked = badgeCandidates.sortedBy { candidate ->
                    kotlin.math.abs(candidate.x - lastLivePriceX) * 2 + kotlin.math.abs(candidate.y - lastLivePriceY)
                }
                val best = ranked.first()
                val bestDistance = kotlin.math.abs(best.x - lastLivePriceX) * 2 + kotlin.math.abs(best.y - lastLivePriceY)
                val secondDistance = ranked.getOrNull(1)?.let {
                    kotlin.math.abs(it.x - lastLivePriceX) * 2 + kotlin.math.abs(it.y - lastLivePriceY)
                } ?: Int.MAX_VALUE
                if (kotlin.math.abs(best.y - lastLivePriceY) <= 100 && secondDistance - bestDistance >= 20) best else null
            }
            else -> null
        }
        val price = if (selectedLive != null) {
            lastLivePriceX = selectedLive.x
            lastLivePriceY = selectedLive.y
            "ORANGE BADGE CANDIDATE: " + selectedLive.value
        } else {
            "UNCONFIRMED (orange badge: " + (if (badge == null) "not detected)" else "${badgeCandidates.size} price candidates)")
        }
        val diagnostics = buildString {
            append("ORANGE PRICE BADGE (dynamic pixel detection):\n")
            append(if (badge != null) "bbox=${badge.left},${badge.top},${badge.right},${badge.bottom}\n" else "ไม่พบป้ายสีส้ม\n")
            append(badgeCandidates.joinToString("\n") {
                it.value + " @ " + it.x + "," + it.y + " | " + it.text
            }.ifBlank { "ไม่พบตัวเลขราคา 5-6 หลักภายในกรอบป้ายส้ม" })
            append("\n\nALL DECIMAL CANDIDATES:\n")
            append(candidates.joinToString("\n") {
                it.value + " (" + it.decimals + "dp) @ " + it.x + "," + it.y + " | " + it.text
            }.ifBlank { "ไม่พบตัวเลขทศนิยมที่เข้าเงื่อนไข" })
        }

        val output = Intent(ACTION_OCR_RESULT).setPackage(packageName).apply {
            putExtra("pair", pair)
            putExtra("market", market)
            putExtra("price", price)
            putExtra("clock", clock)
            putExtra("raw", rawText.take(2600))
            putExtra("candidates", diagnostics.take(2400))
            putExtra("badge_bounds", badge?.let { "${it.left},${it.top},${it.right},${it.bottom}" } ?: "NOT_FOUND")
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
        const val ACTION_MANUAL_SCAN = "com.aisignalradar.clean.MANUAL_SCAN"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        private const val NOTIFICATION_ID = 501
        private const val MIN_FRAME_INTERVAL_MS = 300L
    }
}
