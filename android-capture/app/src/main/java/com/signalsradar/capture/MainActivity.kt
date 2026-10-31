package com.signalsradar.capture

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {
    private val requestCapture = 4102
    private lateinit var webView: WebView
    private val prefs by lazy { getSharedPreferences("radar", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(8, 13, 24))
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(8, 8, 8, 8)
            setBackgroundColor(Color.rgb(17, 28, 46))
        }
        fun actionButton(label: String, onClick: () -> Unit) = Button(this).apply {
            text = label
            textSize = 11f
            isAllCaps = false
            setOnClickListener { onClick() }
        }
        bar.addView(actionButton("ตั้งค่า") { showSettings() }, LinearLayout.LayoutParams(0, -2, 1f))
        bar.addView(actionButton("เริ่มอ่านหน้าจอ") { requestScreenCapture() }, LinearLayout.LayoutParams(0, -2, 1.5f))
        bar.addView(actionButton("หยุด") { stopService(Intent(this, CaptureService::class.java)); toast("หยุดอ่านหน้าจอแล้ว") }, LinearLayout.LayoutParams(0, -2, 0.7f))
        root.addView(bar)

        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(8, 13, 24))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = WebChromeClient()
            addJavascriptInterface(RadarBridge(), "AndroidRadar")
            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
                .build()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView?, request: android.webkit.WebResourceRequest?) =
                    request?.url?.let { loader.shouldInterceptRequest(it) }
            }
            loadUrl("https://appassets.androidplatform.net/assets/index.html")
        }
        root.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private inner class RadarBridge {
        @JavascriptInterface fun getBaseUrl(): String =
            prefs.getString("url", "https://ai-signal-radar-dual.onrender.com")!!.trimEnd('/') + "/"
    }

    private fun showSettings() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 8, 24, 0)
        }
        fun label(s: String) { box.addView(TextView(this).apply { text = s; setTextColor(Color.DKGRAY); textSize = 13f }) }
        fun field(value: String, hintText: String, password: Boolean = false) = EditText(this).apply {
            setSingleLine(true); hint = hintText; setText(value)
            if (password) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        label("Render URL")
        val url = field(prefs.getString("url", "https://ai-signal-radar-dual.onrender.com")!!, "https://...")
        box.addView(url)
        label("SCREEN_INGEST_TOKEN")
        val token = field(prefs.getString("token", "")!!, "Token จาก Render", true)
        box.addView(token)
        label("ตลาดสำหรับการจับภาพ")
        val market = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("MAIN", "OTC"))
            setSelection(prefs.getInt("market", 0).coerceIn(0, 1))
        }
        box.addView(market)
        label("คู่เงิน")
        val pairs = listOf("EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD")
        val pair = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, pairs)
            setSelection(prefs.getInt("pair", 0).coerceIn(0, pairs.lastIndex))
        }
        box.addView(pair)
        val otc = CheckBox(this).apply {
            text = "ยืนยันว่าหน้าจอเป็นกราฟ OTC จริง"
            isChecked = prefs.getBoolean("otc", false)
        }
        box.addView(otc)
        val dialog = AlertDialog.Builder(this)
            .setTitle("ตั้งค่า AI SIGNAL RADAR OCR")
            .setView(ScrollView(this).apply { addView(box) })
            .setNegativeButton("ยกเลิก", null)
            .setPositiveButton("บันทึก", null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val cleanUrl = url.text.toString().trim().trimEnd('/')
                val auth = token.text.toString().trim()
                if (!cleanUrl.startsWith("https://") || auth.isBlank()) {
                    toast("กรุณากรอก HTTPS URL และ Token ให้ครบ")
                    return@setOnClickListener
                }
                if (market.selectedItem.toString() == "OTC" && !otc.isChecked) {
                    toast("กรุณายืนยันตลาด OTC")
                    return@setOnClickListener
                }
                prefs.edit().putString("url", cleanUrl).putString("token", auth)
                    .putInt("market", market.selectedItemPosition).putInt("pair", pair.selectedItemPosition)
                    .putBoolean("otc", otc.isChecked).apply()
                dialog.dismiss()
                toast("บันทึกการตั้งค่าแล้ว")
            }
        }
        dialog.show()
    }

    private fun requestScreenCapture() {
        val url = prefs.getString("url", "")!!.trim()
        val token = prefs.getString("token", "")!!.trim()
        if (!url.startsWith("https://") || token.isBlank()) {
            showSettings()
            toast("กรุณาตั้งค่า Render URL และ Token ก่อน")
            return
        }
        if (prefs.getInt("market", 0) == 1 && !prefs.getBoolean("otc", false)) {
            toast("กรุณายืนยันว่าหน้าจอเป็นกราฟ OTC จริง")
            showSettings()
            return
        }
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), requestCapture)
    }

    @Deprecated("Deprecated in Android but retained for broad device compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == requestCapture && resultCode == RESULT_OK && data != null) {
            val pairs = listOf("EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "NZD/USD")
            val i = Intent(this, CaptureService::class.java).apply {
                action = CaptureService.ACTION_START
                putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
                putExtra(CaptureService.EXTRA_RESULT_DATA, data)
                putExtra(CaptureService.EXTRA_URL, prefs.getString("url", "")!!)
                putExtra(CaptureService.EXTRA_TOKEN, prefs.getString("token", "")!!)
                putExtra(CaptureService.EXTRA_MARKET, if (prefs.getInt("market", 0) == 1) "OTC" else "MAIN")
                putExtra(CaptureService.EXTRA_PAIR, pairs[prefs.getInt("pair", 0).coerceIn(0, pairs.lastIndex)])
                putExtra(CaptureService.EXTRA_OTC, prefs.getBoolean("otc", false))
            }
            startForegroundService(i)
            toast("เริ่มส่งภาพหน้าจอให้ระบบ OCR แล้ว")
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
}
