"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const express = require("express");
const { createScreenSource } = require("../screen-source");

const TOKEN = "test-only-screen-ingest-token-0123456789";

async function startFixture(t) {
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use("/api/screen", createScreenSource({ token: TOKEN }).router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  return { base: `http://127.0.0.1:${address.port}` };
}

test("screen status starts in STANDBY without a fresh OCR tick", async t => {
  const { base } = await startFixture(t);
  const response = await fetch(`${base}/api/screen/status`);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.dataFresh, false);
  assert.equal(data.candidate, "STANDBY");
  assert.equal(data.price, null);
});

test("screen ingest rejects missing or incorrect authorization", async t => {
  const { base } = await startFixture(t);
  const response = await fetch(`${base}/api/screen/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      symbol: "EUR/USD",
      price: 1.08234,
      capturedAt: new Date().toISOString(),
      confidence: 0.8
    })
  });

  assert.equal(response.status, 401);
});

test("valid authenticated OCR tick appears as fresh data but does not invent a signal", async t => {
  const { base } = await startFixture(t);
  const response = await fetch(`${base}/api/screen/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      version: 1,
      symbol: "EUR/USD",
      price: 1.08234,
      capturedAt: new Date().toISOString(),
      confidence: 0.8
    })
  });
  const accepted = await response.json();
  assert.equal(response.status, 200);
  assert.equal(accepted.ok, true);

  const statusResponse = await fetch(`${base}/api/screen/status`);
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.dataFresh, true);
  assert.equal(status.symbol, "EUR/USD");
  assert.equal(status.price, 1.08234);
  assert.equal(status.candidate, "STANDBY");
  assert.equal(status.completedCandles, 0);
});

test("screen ingest rejects stale timestamps", async t => {
  const { base } = await startFixture(t);
  const response = await fetch(`${base}/api/screen/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      version: 1,
      symbol: "EUR/USD",
      price: 1.08234,
      capturedAt: new Date(Date.now() - 30000).toISOString(),
      confidence: 0.8
    })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /เวลา|คลาดเคลื่อน/);
});
