package com.aisignalradar.ocr

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private val captureRequest = 4102
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            setBackgroundColor(0xFF101722.toInt())
        }
        val title = TextView(this).apply {
            text = "AI SIGNAL RADAR OCR\nอ่านหน้าจอ 8xTrade"
            textSize = 22f
            setTextColor(0xFF42D9FF.toInt())
        }
        status = TextView(this).apply {
            text = "พร้อมเริ่ม • ต้องอนุญาตหน้าจอลอยและจับภาพหน้าจอครั้งแรก"
            textSize = 15f
            setTextColor(0xFFFFFFFF.toInt())
            setPadding(0, 24, 0, 24)
        }
        val start = Button(this).apply {
            text = "เริ่มทำงาน"
            setOnClickListener { beginCapture() }
        }
        val stop = Button(this).apply {
            text = "หยุดทำงาน"
            setOnClickListener {
                stopService(Intent(this@MainActivity, CaptureService::class.java))
                status.text = "หยุดทำงานแล้ว"
            }
        }
        layout.addView(title); layout.addView(status); layout.addView(start); layout.addView(stop)
        setContentView(layout)
    }

    private fun beginCapture() {
        if (!Settings.canDrawOverlays(this)) {
            status.text = "กรุณาอนุญาตแสดงทับแอปอื่นหนึ่งครั้ง"
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            return
        }
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), captureRequest)
    }

    @Deprecated("Deprecated by Android; retained for broad device compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == captureRequest && resultCode == RESULT_OK && data != null) {
            val service = Intent(this, CaptureService::class.java).apply {
                putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
                putExtra(CaptureService.EXTRA_RESULT_DATA, data)
            }
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
            status.text = "กำลังอ่านหน้าจอ • เปิดหน้า 8xTrade แล้ววางกราฟไว้บนจอ"
        } else if (requestCode == captureRequest) {
            status.text = "ยังไม่ได้อนุญาตจับภาพหน้าจอ"
        }
    }
}
