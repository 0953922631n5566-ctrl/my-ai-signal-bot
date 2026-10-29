package com.aisignalradar.companion

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : ComponentActivity() {
    private lateinit var server: EditText
    private lateinit var token: EditText
    private lateinit var symbol: EditText
    private lateinit var status: TextView

    private val capturePermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            getSharedPreferences("companion", MODE_PRIVATE).edit()
                .putString("server", server.text.toString().trim().trimEnd('/'))
                .putString("token", token.text.toString())
                .putString("symbol", symbol.text.toString().trim().ifBlank { "EURUSD(OTC)" })
                .apply()
            val intent = Intent(this, CaptureService::class.java).apply {
                putExtra("resultCode", result.resultCode)
                putExtra("resultData", result.data)
            }
            androidx.core.content.ContextCompat.startForegroundService(this, intent)
            status.text = "กำลังแชร์หน้าจอและอ่านราคาในเครื่อง"
        } else {
            status.text = "คุณยังไม่ได้อนุญาตแชร์หน้าจอ"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("companion", MODE_PRIVATE)
        server = EditText(this).apply {
            hint = "Render URL เช่น https://my-ai-signal-bot.onrender.com"
            setSingleLine(true)
            setText(prefs.getString("server", "https://my-ai-signal-bot.onrender.com"))
        }
        token = EditText(this).apply {
            hint = "OTC_INGEST_TOKEN จาก Render (ไม่ส่งให้ใคร)"
            setSingleLine(true)
            setText(prefs.getString("token", ""))
        }
        symbol = EditText(this).apply {
            hint = "ชื่อคู่เงินตามหน้าจอ เช่น EURUSD(OTC)"
            setSingleLine(true)
            setText(prefs.getString("symbol", "EURUSD(OTC)"))
        }
        status = TextView(this).apply {
            text = "แอปจะอ่านเฉพาะข้อความที่เห็นบนหน้าจอ และส่งราคา/เวลา/คะแนน OCR ไป Render"
            textSize = 14f
        }

        val start = Button(this).apply {
            text = "อนุญาตและเริ่มอ่านหน้าจอ"
            setOnClickListener {
                if (!server.text.toString().trim().startsWith("https://") ||
                    token.text.isNullOrBlank()) {
                    status.text = "กรอก Render URL แบบ HTTPS และ OTC_INGEST_TOKEN ก่อน"
                    return@setOnClickListener
                }
                val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                capturePermission.launch(manager.createScreenCaptureIntent())
            }
        }
        val stop = Button(this).apply {
            text = "หยุดอ่านหน้าจอ"
            setOnClickListener {
                stopService(Intent(this@MainActivity, CaptureService::class.java))
                status.text = "หยุดแชร์หน้าจอแล้ว"
            }
        }
        val privacy = TextView(this).apply {
            text = "ความเป็นส่วนตัว: ไม่บันทึกภาพหน้าจอหรือรหัสผ่าน ไม่ควบคุม IQ Option และไม่ส่งคำสั่งซื้อขาย ระบบอาจอ่านผิดหรืออ่านไม่ได้หากแอปป้องกันการจับภาพ"
            textSize = 12f
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 32, 28, 24)
            addView(TextView(this@MainActivity).apply {
                text = "AI Signal Radar · OTC Companion"
                textSize = 22f
            })
            addView(server)
            addView(token)
            addView(symbol)
            addView(start)
            addView(stop)
            addView(status)
            addView(privacy)
        })
    }
}
