"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createScreenSource } = require("../screen-source");

const TOKEN = "test-screen-ingest-token-0123456789abcdef";

async function startServer(token = TOKEN) {
  const app = express();
  app.use(express.json({ limit: "20kb" }));
  app.use("/api/screen", createScreenSource({ token }).router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  return {
    base: "http://127.0.0.1:" + address.port,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function validPayload(overrides = {}) {
  return {
    version: 1,
    symbol: "EUR/USD",
    price: 1.12345,
    capturedAt: new Date().toISOString(),
    confidence: 0.8,
    ...overrides
  };
}

async function postTick(base, payload, token = TOKEN) {
  return fetch(base + "/api/screen/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token
    },
    body: JSON.stringify(payload)
  });
}

test("status starts in STANDBY with no fresh screen tick", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const response = await fetch(server.base + "/api/screen/status");
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.dataFresh, false);
  assert.equal(data.candidate, "STANDBY");
  assert.equal(data.price, null);
});

test("ingest requires the correct bearer token", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const response = await postTick(server.base, validPayload(), "wrong-token");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});

test("accepts a fresh valid tick and publishes only a fresh price", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const response = await postTick(server.base, validPayload());
  const accepted = await response.json();
  assert.equal(response.status, 200);
  assert.equal(accepted.ok, true);
  const statusResponse = await fetch(server.base + "/api/screen/status", {
    headers: { "cache-control": "no-cache" }
  });
  const status = await statusResponse.json();
  assert.equal(status.dataFresh, true);
  assert.equal(status.price, 1.12345);
  assert.equal(status.symbol, "EUR/USD");
  assert.equal(status.candidate, "STANDBY");
});

test("rejects an old captured timestamp", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const stale = new Date(Date.now() - 15000).toISOString();
  const response = await postTick(server.base, validPayload({ capturedAt: stale }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /เก่าหรือคลาดเคลื่อน/);
});

test("rejects unsupported pairs and low OCR confidence", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const pairResponse = await postTick(server.base, validPayload({ symbol: "BTC/USD" }));
  assert.equal(pairResponse.status, 400);
  const confidenceResponse = await postTick(server.base, validPayload({ confidence: 0.4 }));
  assert.equal(confidenceResponse.status, 400);
});

test("refuses ingestion when the Render token is not configured", async t => {
  const server = await startServer("");
  t.after(() => server.close());
  const response = await postTick(server.base, validPayload());
  assert.equal(response.status, 503);
});
