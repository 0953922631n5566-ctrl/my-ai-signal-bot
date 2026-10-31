package com.aisignalradar.clean

import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/**
 * Builds one-minute candles only from timestamped, confirmed OCR badge observations.
 * These are observed-price candles, not broker-native OHLC candles.
 */
class PriceCandleBuilder(
    private val minimumSamples: Int = 3,
    private val maxAgeMs: Long = 2_500L,
    private val maxCandles: Int = 500
) {
    data class Candle(
        val pair: String,
        val market: String,
        val minuteStartMs: Long,
        val open: Double,
        val high: Double,
        val low: Double,
        val close: Double,
        val samples: Int,
        val complete: Boolean
    )

    data class Result(val accepted: Boolean, val reason: String, val candle: Candle?)

    private data class StreamState(
        var current: Candle,
        var lastTimestampMs: Long
    )

    private val streams = mutableMapOf<String, StreamState>()
    private val history = mutableMapOf<String, ArrayDeque<Candle>>()

    @Synchronized
    fun addTick(
        pairInput: String,
        marketInput: String,
        priceInput: String,
        capturedAtMs: Long,
        nowMs: Long = System.currentTimeMillis()
    ): Result {
        val pair = pairInput.trim().uppercase(Locale.US).replace(" ", "")
        if (!Regex("^[A-Z]{3}[/\\-][A-Z]{3}$").matches(pair)) {
            return Result(false, "คู่เงินไม่ถูกต้อง", null)
        }
        val market = marketInput.trim().uppercase(Locale.US)
        if (market != "MAIN" && market != "OTC") {
            return Result(false, "ไม่ทราบประเภทตลาด", null)
        }
        val price = priceInput.toDoubleOrNull()
        if (price == null || !price.isFinite() || price <= 0.0) {
            return Result(false, "ราคา OCR ไม่ถูกต้อง", null)
        }
        if (capturedAtMs <= 0L || capturedAtMs > nowMs + 1_000L || nowMs - capturedAtMs > maxAgeMs) {
            return Result(false, "ข้อมูลราคาเก่าหรือเวลาไม่ถูกต้อง", null)
        }

        val key = "$pair|$market"
        val minute = capturedAtMs / 60_000L * 60_000L
        val state = streams[key]
        if (state != null && capturedAtMs <= state.lastTimestampMs) {
            return Result(false, "ข้อมูลซ้ำหรือเวลาไม่เรียง", state.current)
        }

        val next = if (state == null || minute > state.current.minuteStartMs) {
            val candle = Candle(pair, market, minute, price, price, price, price, 1, false)
            if (state != null) {
                val closed = state.current.copy(complete = state.current.samples >= minimumSamples)
                history.getOrPut(key) { ArrayDeque() }.addLast(closed)
                while (history.getValue(key).size > maxCandles) history.getValue(key).removeFirst()
            }
            StreamState(candle, capturedAtMs)
        } else if (minute < state.current.minuteStartMs) {
            return Result(false, "ข้อมูลย้อนกลับไปยังนาทีเก่า", state.current)
        } else {
            val c = state.current
            state.copy(
                current = c.copy(
                    high = max(c.high, price),
                    low = min(c.low, price),
                    close = price,
                    samples = c.samples + 1
                ),
                lastTimestampMs = capturedAtMs
            )
        }
        streams[key] = next
        return Result(true, "กำลังสะสมราคา OCR ${next.current.samples}/$minimumSamples", next.current)
    }

    @Synchronized
    fun summary(pairInput: String, marketInput: String, nowMs: Long = System.currentTimeMillis()): String {
        val pair = pairInput.trim().uppercase(Locale.US).replace(" ", "")
        val market = marketInput.trim().uppercase(Locale.US)
        val state = streams["$pair|$market"] ?: return "ยังไม่มีข้อมูลราคา OCR ที่ยืนยันแล้ว"
        val candle = state.current
        if (nowMs - state.lastTimestampMs > maxAgeMs) return "STANDBY: ราคา OCR ไม่อัปเดต"
        val readiness = if (candle.samples >= minimumSamples) "กำลังสะสมครบเกณฑ์" else "ข้อมูลยังไม่พอ"
        return "$readiness • ${candle.samples} samples • O ${candle.open} H ${candle.high} L ${candle.low} C ${candle.close}"
    }

    @Synchronized
    fun recentClosed(pairInput: String, marketInput: String): List<Candle> {
        val key = "${pairInput.trim().uppercase(Locale.US).replace(" ", "")}|${marketInput.trim().uppercase(Locale.US)}"
        return history[key]?.toList() ?: emptyList()
    }
}
