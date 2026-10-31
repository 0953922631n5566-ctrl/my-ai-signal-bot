package com.aisignalradar.clean

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private lateinit var status: TextView
    private lateinit var pair: TextView
    private lateinit var market: TextView
    private lateinit var price: TextView
    private lateinit var clock: TextView
    private lateinit var candidates: TextView
    private lateinit var raw: TextView
    private val projectionRequest = 701

    private val resultReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != CaptureService.ACTION_OCR_RESULT) return
            pair.text = "คู่เงิน: " + (intent.getStringExtra("pair") ?: "ไม่พบ")
            market.text = "ตลาด: " + (intent.getStringExtra("market") ?: "UNKNOWN")
            price.text = "ราคา OCR: " + (intent.getStringExtra("price") ?: "ยังยืนยันไม่ได้")
            clock.text = "เวลาที่อ่านได้: " + (intent.getStringExtra("clock") ?: "ไม่พบ")
            candidates.text = "ตัวเลขที่พบและตำแหน่งบนจอ:\\n" +
                (intent.getStringExtra("candidates") ?: "—") +
                "\\nขนาดจอ: ${intent.getIntExtra("screen_width", 0)} × ${intent.getIntExtra("screen_height", 0)}"
            raw.text = "ข้อความ OCR ดิบ:\\n" + (intent.getStringExtra("raw") ?: "")
            status.text = "กำลังอ่านหน้าจอ • ติดตามป้ายราคาที่เลื่อนตามแท่งเทียน"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildScreen()
        val filter = IntentFilter(CaptureService.ACTION_OCR_RESULT)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(resultReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else {
            @Suppress("DEPRECATION")
            registerReceiver(resultReceiver, filter)
        }
    }

    private fun buildScreen() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 28, 24, 24)
            setBackgroundColor(0xFF10151F.toInt())
        }
        val heading = TextView(this).apply {
            text = "AI SIGNAL RADAR OCR • CLEAN"
            textSize = 21f
            setTextColor(0xFF62E6C5.toInt())
            gravity = Gravity.CENTER
        }
        status = makeText("สถานะ: STANDBY")
        pair = makeText("คู่เงิน: —")
        market = makeText("ตลาด: UNKNOWN")
        price = makeText("ราคา OCR: ยังไม่ยืนยัน")
        clock = makeText("เวลาที่อ่านได้: —")
        candidates = makeText("ตัวเลขที่พบและตำแหน่งบนจอ: —")
        raw = makeText("ข้อความ OCR ดิบจะปรากฏที่นี่")
        val start = Button(this).apply {
            text = "เริ่มอ่านหน้าจอ"
            setOnClickListener { requestCapture() }
        }
        val stop = Button(this).apply {
            text = "หยุดอ่านหน้าจอ"
            setOnClickListener {
                stopService(Intent(this@MainActivity, CaptureService::class.java))
                status.text = "สถานะ: หยุดอ่านแล้ว"
            }
        }
        val manual = Button(this).apply {
            text = "อ่านซ้ำ (Manual Scan)"
            setOnClickListener {
                val scanIntent = Intent(this@MainActivity, CaptureService::class.java).apply {
                    action = CaptureService.ACTION_MANUAL_SCAN
                }
                ContextCompat.startForegroundService(this@MainActivity, scanIntent)
                status.text = "ส่งคำสั่งอ่านหน้าจอซ้ำแล้ว..."
            }
        }
        root.addView(heading); root.addView(status); root.addView(start); root.addView(stop); root.addView(manual)
        root.addView(pair); root.addView(market); root.addView(price); root.addView(clock)
        root.addView(candidates); root.addView(raw)
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun makeText(value: String) = TextView(this).apply {
        text = value
        textSize = 15f
        setTextColor(0xFFE8EDF5.toInt())
        setPadding(0, 12, 0, 12)
    }

    private fun requestCapture() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), projectionRequest)
    }

    @Deprecated("Deprecated by Android; retained for MediaProjection consent result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != projectionRequest) return
        if (resultCode != Activity.RESULT_OK || data == null) {
            status.text = "ไม่ได้รับอนุญาตให้อ่านหน้าจอ"
            return
        }
        val serviceIntent = Intent(this, CaptureService::class.java).apply {
            putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(CaptureService.EXTRA_RESULT_DATA, data)
        }
        ContextCompat.startForegroundService(this, serviceIntent)
        status.text = "กำลังเริ่มระบบอ่านหน้าจอ..."
    }

    override fun onDestroy() {
        try { unregisterReceiver(resultReceiver) } catch (_: Exception) { }
        super.onDestroy()
    }
}
