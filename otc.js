"use strict";

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const MAX_AGE_MS = 15000;
let latest = null;
let lastAcceptedAt = 0;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

router.post("/capture", (req, res) => {
  const expected = process.env.OTC_INGEST_TOKEN;
  if (!expected) {
    return res.status(503).json({ ok: false, error: "OTC_INGEST_TOKEN ยังไม่ได้ตั้งใน Render" });
  }
  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const now = Date.now();
  if (now - lastAcceptedAt < 250) {
    return res.status(429).json({ ok: false, error: "ส่งข้อมูลถี่เกินไป" });
  }

  const body = req.body || {};
  const symbol = String(body.symbol || "").toUpperCase().replace(/[^A-Z0-9/()_-]/g, "").slice(0, 24);
  const price = Number(body.price);
  const confidence = Number(body.confidence);
  const capturedAt = Date.parse(body.capturedAt || "");

  if (!symbol || !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      !Number.isFinite(capturedAt) || Math.abs(now - capturedAt) > 30000) {
    return res.status(400).json({ ok: false, error: "ข้อมูลราคา/เวลา/ความเชื่อมั่นไม่ถูกต้องหรือเก่าเกินไป" });
  }

  latest = {
    market: "OTC",
    symbol,
    price,
    confidence,
    capturedAt: new Date(capturedAt).toISOString(),
    receivedAt: new Date(now).toISOString(),
    source: "Android MediaProjection + on-device OCR",
    // A price read from a screenshot is not enough to claim a validated trading signal.
    candidate: "STANDBY",
    reason: confidence < 0.85
      ? "ความเชื่อมั่น OCR ต่ำ ต้องตรวจสอบหน้าจอ"
      : "กำลังรวบรวมข้อมูล OTC; ยังไม่มีสัญญาณที่ผ่านการตรวจสอบ"
  };
  lastAcceptedAt = now;
  return res.json({ ok: true, receivedAt: latest.receivedAt });
});

router.get("/status", (_req, res) => {
  res.set("Cache-Control", "no-store");
  const age = latest ? Date.now() - Date.parse(latest.receivedAt) : Infinity;
  const fresh = age <= MAX_AGE_MS;
  res.json({
    ok: fresh,
    configured: Boolean(process.env.OTC_INGEST_TOKEN),
    dataFresh: fresh,
    ageMs: Number.isFinite(age) ? age : null,
    data: fresh ? latest : null,
    candidate: "STANDBY",
    reason: fresh ? latest.reason : "ยังไม่มีข้อมูล OTC ใหม่จากแอป Android"
  });
});

module.exports = router;
