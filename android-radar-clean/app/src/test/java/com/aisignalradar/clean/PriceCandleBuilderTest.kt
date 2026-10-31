package com.aisignalradar.clean

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PriceCandleBuilderTest {
    private val base = 1_800_000_000_000L

    @Test
    fun aggregatesObservedOhlcAndClosesMinute() {
        val builder = PriceCandleBuilder(minimumSamples = 3)
        assertTrue(builder.addTick("EUR/USD", "OTC", "1.10000", base, base).accepted)
        assertTrue(builder.addTick("EUR/USD", "OTC", "1.10020", base + 1_000, base + 1_000).accepted)
        assertTrue(builder.addTick("EUR/USD", "OTC", "1.09990", base + 2_000, base + 2_000).accepted)
        builder.addTick("EUR/USD", "OTC", "1.10010", base + 60_000, base + 60_000)
        val closed = builder.recentClosed("EUR/USD", "OTC").single()
        assertEquals(1.10000, closed.open, 0.0000001)
        assertEquals(1.10020, closed.high, 0.0000001)
        assertEquals(1.09990, closed.low, 0.0000001)
        assertEquals(1.09990, closed.close, 0.0000001)
        assertEquals(3, closed.samples)
        assertTrue(closed.complete)
    }

    @Test
    fun rejectsStaleDuplicateAndUnknownMarketTicks() {
        val builder = PriceCandleBuilder()
        assertFalse(builder.addTick("EUR/USD", "OTC", "1.10000", base, base + 3_000).accepted)
        assertTrue(builder.addTick("EUR/USD", "OTC", "1.10000", base, base).accepted)
        assertFalse(builder.addTick("EUR/USD", "OTC", "1.10010", base, base).accepted)
        assertFalse(builder.addTick("EUR/USD", "UNKNOWN", "1.10010", base + 1_000, base + 1_000).accepted)
    }

    @Test
    fun keepsMainAndOtcStreamsSeparate() {
        val builder = PriceCandleBuilder()
        assertTrue(builder.addTick("EUR/USD", "MAIN", "1.08000", base, base).accepted)
        assertTrue(builder.addTick("EUR/USD", "OTC", "1.10000", base, base).accepted)
        assertTrue(builder.summary("EUR/USD", "MAIN", base).contains("1.08"))
        assertTrue(builder.summary("EUR/USD", "OTC", base).contains("1.1"))
    }

    @Test
    fun incompleteMinuteIsNotMarkedComplete() {
        val builder = PriceCandleBuilder(minimumSamples = 3)
        builder.addTick("EUR/USD", "OTC", "1.10000", base, base)
        builder.addTick("EUR/USD", "OTC", "1.10010", base + 1_000, base + 1_000)
        builder.addTick("EUR/USD", "OTC", "1.10020", base + 60_000, base + 60_000)
        assertFalse(builder.recentClosed("EUR/USD", "OTC").single().complete)
    }
}
