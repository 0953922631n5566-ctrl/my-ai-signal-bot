package com.signalsradar.capture

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.*

class MainActivity : Activity() {
    private lateinit var baseUrl: EditText
    private lateinit var token: EditText
    private lateinit var market: Spinner
    private lateinit var pair: Spinner
    private lateinit var otcConfirm: CheckBox
    private val requestCapture = 4102

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("radar", MODE_PRIVATE)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 28, 24, 24)
            setBackgroundColor(Color.rgb(12, 18, 32))
        }
        fun label(text: String) = TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextColor(Color.WHITE)
            setPadding(0, 12, 0, 6)
        }
        fun fieldBackground() = GradientDrawable().apply {
            setColor(Color.rgb(43, 52, 68))
            cornerRadius = 14f
            setStroke(1, Color.rgb(83, 99, 122))
        }
        fun styleField(field: EditText) {
            field.setTextColor(Color.WHITE)
            field.setHintTextColor(Color.rgb(178, 190, 207))
            field.background = fieldBackground()
            field.setPadding(16, 13, 16, 13)
            field.textSize = 16f
        }

        val title = TextView(this).apply {
            text = "AI SIGNAL RADAR"
            textSize = 24f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, 8, 0, 8)
        }
        root.addView(title)
        root.addView(label("ที่อยู่ระบบ Render"))
        baseUrl = EditText(this).apply {
            setSingleLine(true)
            setText(prefs.getString("url", "https://ai-signal-radar-dual.onrender.com"))
            hint = "https://your-service.onrender.com"
        }
        styleField(baseUrl)
        root.addView(baseUrl)

        root.addView(label("SCREEN_INGEST_TOKEN"))
        token = EditText(this).apply {
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(prefs.getString("token", ""))
            hint = "ใส่ Token จาก Render"
        }
        styleField(token)
        root.addView(token)

        root.addView(label("เลือกตลาด"))
        market = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("MAIN", "OTC"))
            setSelection(prefs.getInt("market", 0).coerceIn(0, 1))
        }
        root.addView(market)

        root.addView(label("เลือกคู่เงิน"))
        pair = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                listOf("EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD"))
            setSelection(prefs.getInt("pair", 0).coerceIn(0, 5))
        }
        root.addView(pair)

        otcConfirm = CheckBox(this).apply {
            text = "ยืนยันว่าหน้าจอเป็นกราฟ OTC จริง"
            setTextColor(Color.WHITE)
            isChecked = prefs.getBoolean("otc", false)
        }
        root.addView(otcConfirm)

        val save = Button(this).apply {
            text = "บันทึก / เซฟข้อมูล"
            setOnClickListener {
                val url = baseUrl.text.toString().trim().trimEnd('/')
                val auth = token.text.toString().trim()
                if (!url.startsWith("https://") || auth.isBlank()) {
                    Toast.makeText(this@MainActivity, "กรุณาใส่ URL https และ Token ให้ครบก่อนบันทึก", Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                saveSettings(prefs)
                Toast.makeText(this@MainActivity, "บันทึกข้อมูลไว้ในเครื่องแล้ว", Toast.LENGTH_SHORT).show()
            }
        }
        root.addView(save)

        val start = Button(this).apply {
            text = "เริ่มแชร์หน้าจอ"
            setOnClickListener {
                val url = baseUrl.text.toString().trim().trimEnd('/')
                val auth = token.text.toString().trim()
                if (!url.startsWith("https://") || auth.isBlank()) {
                    Toast.makeText(this@MainActivity, "กรุณาใส่ URL https และ Token ให้ครบ", Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                if (market.selectedItem.toString() == "OTC" && !otcConfirm.isChecked) {
                    Toast.makeText(this@MainActivity, "กรุณายืนยันว่าเป็นกราฟ OTC", Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                saveSettings(prefs)
                val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                startActivityForResult(mgr.createScreenCaptureIntent(), requestCapture)
            }
        }
        root.addView(start)

        val stop = Button(this).apply {
            text = "หยุดแชร์หน้าจอ"
            setOnClickListener { stopService(Intent(this@MainActivity, CaptureService::class.java)) }
        }
        root.addView(stop)

        val note = TextView(this).apply {
            text = "หมายเหตุ: ข้อมูลการตั้งค่าจะถูกบันทึกไว้ในเครื่องนี้ เมื่อเปิดแอปครั้งต่อไปไม่ต้องกรอกใหม่ ข้อมูล Token เก็บในพื้นที่ส่วนตัวของแอป อย่าแชร์ไฟล์หรือข้อมูลสำรองให้ผู้อื่น\n\nAndroid จะแสดงหน้าต่างให้คุณอนุญาตแชร์หน้าจอทุกครั้งที่เริ่ม แอปส่งภาพไปยังระบบ OCR เท่านั้น ไม่ส่งคำสั่งซื้อขาย"
            textSize = 13f
            setTextColor(Color.LTGRAY)
            setPadding(0, 18, 0, 0)
        }
        root.addView(note)
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun saveSettings(prefs: android.content.SharedPreferences) {
        prefs.edit()
            .putString("url", baseUrl.text.toString().trim().trimEnd('/'))
            .putString("token", token.text.toString().trim())
            .putInt("market", market.selectedItemPosition)
            .putInt("pair", pair.selectedItemPosition)
            .putBoolean("otc", otcConfirm.isChecked)
            .apply()
    }

    @Deprecated("Deprecated in Android but retained for broad device compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == requestCapture && resultCode == RESULT_OK && data != null) {
            val i = Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_START
                putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
                putExtra(CaptureService.EXTRA_RESULT_DATA, data)
                putExtra(CaptureService.EXTRA_URL, baseUrl.text.toString().trim().trimEnd('/'))
                putExtra(CaptureService.EXTRA_TOKEN, token.text.toString().trim())
                putExtra(CaptureService.EXTRA_MARKET, market.selectedItem.toString())
                putExtra(CaptureService.EXTRA_PAIR, pair.selectedItem.toString())
                putExtra(CaptureService.EXTRA_OTC, otcConfirm.isChecked)
            }
            startForegroundService(i)
            Toast.makeText(this, "เริ่มแชร์หน้าจอแล้ว", Toast.LENGTH_SHORT).show()
        }
    }
}
