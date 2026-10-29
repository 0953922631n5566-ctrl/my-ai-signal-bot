package com.aisignalradar.screencompanion

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var serverInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var symbolInput: EditText
    private lateinit var status: TextView
    private val requestCapture = 701

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (18 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun label(value: String) {
            layout.addView(TextView(this).apply { text = value; textSize = 15f })
        }
        fun field(hintText: String, value: String = ""): EditText {
            return EditText(this).apply {
                hint = hintText
                setText(value)
                isSingleLine = true
                layout.addView(this)
            }
        }

        label("AI Signal Radar · 8xTrade Screen")
        label("ข้อมูลจะถูกอ่านด้วย OCR ในเครื่องก่อนส่งราคาไป Render")
        serverInput = field("Render URL เช่น https://your-service.onrender.com")
        tokenInput = field("SCREEN_INGEST_TOKEN")
        tokenInput.inputType = 129
        symbolInput = field("คู่เงิน เช่น EUR/USD", "EUR/USD")
        status = TextView(this).apply {
            text = "สถานะ: ยังไม่เริ่มจับภาพ"
            textSize = 14f
            setPadding(0, pad, 0, pad)
        }
        layout.addView(status)

        layout.addView(Button(this).apply {
            text = "เริ่มจับภาพอัตโนมัติ"
            setOnClickListener {
                val base = serverInput.text.toString().trim().trimEnd('/')
                val secret = tokenInput.text.toString().trim()
                val symbol = symbolInput.text.toString().trim().uppercase()
                if (!base.startsWith("https://") || secret.length < 32) {
                    Toast.makeText(this@MainActivity, "ตรวจสอบ URL HTTPS และ token อย่างน้อย 32 ตัวอักษร", Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                if (!symbol.matches(Regex("[A-Z]{3}/[A-Z]{3}"))) {
                    Toast.makeText(this@MainActivity, "ใส่คู่เงินรูปแบบ EUR/USD", Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                startActivityForResult(manager.createScreenCaptureIntent(), requestCapture)
            }
        })
        layout.addView(Button(this).apply {
            text = "หยุดจับภาพ"
            setOnClickListener {
                stopService(Intent(this@MainActivity, ScreenCaptureService::class.java))
                status.text = "สถานะ: ส่งคำสั่งหยุดแล้ว"
            }
        })
        layout.addView(TextView(this).apply {
            text = "ข้อจำกัด: จับภาพทั้งหน้าจอและอ่านเฉพาะตัวเลขที่ไม่กำกวม หากอ่านราคาไม่ได้จะไม่ส่งข้อมูลใหม่ ระบบควรแสดง STANDBY"
            textSize = 12f
            setPadding(0, pad, 0, 0)
        })
        setContentView(layout)
    }

    @Deprecated("Android compatibility callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != requestCapture) return
        if (resultCode != RESULT_OK || data == null) {
            status.text = "สถานะ: ไม่ได้รับอนุญาตจับภาพ"
            return
        }
        val service = Intent(this, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(ScreenCaptureService.EXTRA_DATA, data)
            putExtra(ScreenCaptureService.EXTRA_SERVER, serverInput.text.toString().trim().trimEnd('/'))
            putExtra(ScreenCaptureService.EXTRA_TOKEN, tokenInput.text.toString().trim())
            putExtra(ScreenCaptureService.EXTRA_SYMBOL, symbolInput.text.toString().trim().uppercase())
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        status.text = "สถานะ: กำลังจับภาพ — เปิดหน้า 8xTrade เพื่อทดสอบ"
    }
}
