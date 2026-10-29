"use strict";

const crypto = require("node:crypto");
const express = require("express");

const ALLOWED_SYMBOLS = new Set([
  "EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD",
  "NZD/USD", "EUR/GBP", "EUR/JPY", "GBP/JPY"
]);

const MAX_AGE_MS = 6000;
const MAX_CAPTURE_AGE_MS = 5000;
const MAX_FUTURE_SKEW_MS = 2000;
const MIN_CONFIDENCE = 0.75;
const MIN_INGEST_INTERVAL_MS = 150;

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const out = Array(period - 1).fill(null);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(current);
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    out.push(current);
  }
  return out;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function createScreenSource({ token = "" } = {}) {
  const router = express.Router();
  const completedCandles = [];
  let currentCandle = null;
  let lastTickAt = 0;
  let lastAcceptedAt = 0;
  let lastPrice = null;
  let lastSymbol = "EUR/USD";
  let lastReceivedAt = null;
  let lastConfidence = 0;
  let lastError = "รอข้อมูลจากแอป Android";
  let lastAnalysis = null;

  function publicState() {
    const age = lastTickAt ? Date.now() - lastTickAt : Infinity;
    const fresh = age >= 0 && age <= MAX_AGE_MS;
    const analysis = lastAnalysis;
    return {
      source: "8xTrade Screen OCR",
      symbol: lastSymbol,
      interval: "1min",
      price: fresh ? round(lastPrice, 7) : null,
      candleTime: analysis?.candleTime ||
        (currentCandle ? new Date(currentCandle.time).toISOString() : null),
      fetchedAt: lastReceivedAt,
      dataAgeMs: Number.isFinite(age) ? age : null,
      dataFresh: fresh,
      ema9: fresh ? analysis?.ema9 ?? null : null,
      ema21: fresh ? analysis?.ema21 ?? null : null,
      ema50: fresh ? analysis?.ema50 ?? null : null,
      rsi14: fresh ? analysis?.rsi14 ?? null : null,
      macd: fresh ? analysis?.macd ?? null : null,
      bullVotes: fresh ? analysis?.bullVotes ?? 0 : 0,
      bearVotes: fresh ? analysis?.bearVotes ?? 0 : 0,
      score: fresh && analysis ? analysis.score : 0,
      candidate: fresh && analysis ? analysis.candidate : "STANDBY",
      reason: !fresh
        ? (lastError || "ข้อมูลหน้าจอเก่าหรือไม่พร้อม")
        : !analysis
          ? "กำลังสะสมแท่งปิดจาก OCR (" + completedCandles.length + "/50 แท่ง)"
          : analysis.reason,
      error: fresh ? null : lastError,
      minScore: 70,
      signalDurationMs: 40000,
      ocrConfidence: fresh ? lastConfidence : null,
      completedCandles: completedCandles.length
    };
  }

  function analyzeClosedCandles() {
    if (completedCandles.length < 50) return null;
    const candles = completedCandles.slice(-600);
    const closes = candles.map(c => c.close);
    const e9 = emaSeries(closes, 9);
    const e21 = emaSeries(closes, 21);
    const e50 = emaSeries(closes, 50);
    const r = rsi(closes, 14);
    const fast = ema(closes, 12);
    const slow = ema(closes, 26);
    const macd = Number.isFinite(fast) && Number.isFinite(slow) ? fast - slow : null;
    const i = candles.length - 1;
    const latest = candles[i];
    const last3 = [i - 2, i - 1, i].map(j => ({
      candle: candles[j], e9: e9[j], e21: e21[j], e50: e50[j]
    }));
    if ([e9[i], e21[i], e50[i], r, macd].some(v => !Number.isFinite(v)) ||
        last3.some(x => [x.e9, x.e21, x.e50].some(v => !Number.isFinite(v)))) {
      return null;
    }

    const upStacks = last3.filter(x => x.e9 > x.e21 && x.e21 > x.e50).length;
    const downStacks = last3.filter(x => x.e9 < x.e21 && x.e21 < x.e50).length;
    const oldest = last3[0];
    const newest = last3[2];
    const upSlope = newest.e9 > oldest.e9 && newest.e21 > oldest.e21 &&
      newest.e50 >= oldest.e50;
    const downSlope = newest.e9 < oldest.e9 && newest.e21 < oldest.e21 &&
      newest.e50 <= oldest.e50;

    const call = upStacks >= 2 && upSlope &&
      newest.e9 > newest.e21 && newest.e21 > newest.e50 &&
      latest.close > e21[i] && latest.close > latest.open &&
      r >= 50 && r <= 80 && macd > 0;
    const put = downStacks >= 2 && downSlope &&
      newest.e9 < newest.e21 && newest.e21 < newest.e50 &&
      latest.close < e21[i] && latest.close < latest.open &&
      r >= 20 && r <= 50 && macd < 0;

    const recent = candles.slice(-7);
    const avgRange = recent.reduce((sum, c) => sum + c.high - c.low, 0) / recent.length;
    const overextended = avgRange > 0 &&
      Math.abs(latest.close - e9[i]) > avgRange * 1.8;

    let bullVotes = 0;
    let bearVotes = 0;
    if (e9[i] > e21[i]) bullVotes++; else if (e9[i] < e21[i]) bearVotes++;
    if (e21[i] > e50[i]) bullVotes++; else if (e21[i] < e50[i]) bearVotes++;
    if (latest.close > e9[i]) bullVotes++; else if (latest.close < e9[i]) bearVotes++;
    if (r >= 50 && r <= 80) bullVotes++; else if (r >= 20 && r < 50) bearVotes++;
    if (macd > 0) bullVotes++; else if (macd < 0) bearVotes++;

    const score = Math.round(Math.max(bullVotes, bearVotes) * 20);
    let candidate = "STANDBY";
    let reason = "STANDBY: แนวโน้มยังไม่ยืนยันจากแท่งปิด 3 แท่งล่าสุด";
    if (overextended && (call || put)) {
      reason = "STANDBY: ราคาห่าง EMA9 มากเกินไป รอจังหวะย่อ";
    } else if (call) {
      candidate = "CALL";
      reason = "ตามแนวโน้มขาขึ้น: EMA 9/21/50, RSI, MACD และแท่งปิดยืนยันสอดคล้องกัน";
    } else if (put) {
      candidate = "PUT";
      reason = "ตามแนวโน้มขาลง: EMA 9/21/50, RSI, MACD และแท่งปิดยืนยันสอดคล้องกัน";
    }

    return {
      ema9: round(e9[i]),
      ema21: round(e21[i]),
      ema50: round(e50[i]),
      rsi14: round(r, 2),
      macd: round(macd, 8),
      bullVotes,
      bearVotes,
      score,
      candidate: overextended ? "STANDBY" : candidate,
      reason,
      candleTime: new Date(latest.time).toISOString()
    };
  }

  function safeTokenMatch(supplied) {
    if (!token || typeof supplied !== "string") return false;
    const expected = Buffer.from(token, "utf8");
    const actual = Buffer.from(supplied, "utf8");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function requireToken(req, res, next) {
    if (!token || token.length < 32) {
      return res.status(503).json({
        ok: false,
        error: "SCREEN_INGEST_TOKEN ยังไม่ได้ตั้งค่าหรือสั้นเกินไป"
      });
    }
    const authorization = req.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!safeTokenMatch(supplied)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  }

  router.get("/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.status(200).json(publicState());
  });

  router.post("/ingest", requireToken, (req, res) => {
    const now = Date.now();
    try {
      const body = req.body || {};
      if (body.version !== 1) throw new Error("เวอร์ชันข้อมูลไม่รองรับ");

      const symbol = String(body.symbol || "").trim().toUpperCase();
      const price = Number(body.price);
      const confidence = Number(body.confidence);
      const capturedAt = Date.parse(String(body.capturedAt || ""));

      if (!ALLOWED_SYMBOLS.has(symbol)) throw new Error("คู่เงินไม่อยู่ในรายการที่รองรับ");
      if (!Number.isFinite(price) || price <= 0 || price > 1000000) {
        throw new Error("ราคาไม่ถูกต้อง");
      }
      if (!Number.isFinite(capturedAt) ||
          capturedAt > now + MAX_FUTURE_SKEW_MS ||
          now - capturedAt > MAX_CAPTURE_AGE_MS) {
        throw new Error("เวลาจับภาพเก่าหรือคลาดเคลื่อนเกินกำหนด");
      }
      if (!Number.isFinite(confidence) ||
          confidence < MIN_CONFIDENCE || confidence > 1) {
        throw new Error("ความเชื่อมั่นตัวแยกราคาไม่ผ่านเกณฑ์");
      }
      if (now - lastAcceptedAt < MIN_INGEST_INTERVAL_MS) {
        return res.status(429).json({ ok: false, error: "ส่งข้อมูลถี่เกินไป" });
      }

      const minute = Math.floor(capturedAt / 60000) * 60000;

      // Never mix candles from different pairs.
      if (symbol !== lastSymbol) {
        completedCandles.length = 0;
        currentCandle = null;
        lastAnalysis = null;
        lastSymbol = symbol;
      }

      if (currentCandle && minute < currentCandle.time) {
        throw new Error("ข้อมูลมาจากแท่งเวลาที่เก่ากว่าแท่งปัจจุบัน");
      }

      if (!currentCandle) {
        currentCandle = {
          time: minute, symbol, open: price, high: price, low: price, close: price, ticks: 1
        };
      } else if (minute > currentCandle.time) {
        if (minute === currentCandle.time + 60000 &&
            currentCandle.symbol === symbol) {
          completedCandles.push(currentCandle);
          if (completedCandles.length > 600) completedCandles.shift();
          lastAnalysis = analyzeClosedCandles();
        } else {
          // Missing minutes invalidate consecutive-candle assumptions.
          completedCandles.length = 0;
          lastAnalysis = null;
        }
        currentCandle = {
          time: minute, symbol, open: price, high: price, low: price, close: price, ticks: 1
        };
      } else {
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;
        currentCandle.ticks++;
      }

      lastAcceptedAt = now;
      lastTickAt = now;
      lastPrice = price;
      lastSymbol = symbol;
      lastReceivedAt = new Date(now).toISOString();
      lastConfidence = confidence;
      lastError = null;

      res.set("Cache-Control", "no-store");
      return res.json({ ok: true, receivedAt: lastReceivedAt });
    } catch (error) {
      lastError = error.message || "ข้อมูล OCR ไม่ถูกต้อง";
      return res.status(400).json({ ok: false, error: lastError });
    }
  });

  return { router, getPublicState: publicState };
}

module.exports = { createScreenSource };
