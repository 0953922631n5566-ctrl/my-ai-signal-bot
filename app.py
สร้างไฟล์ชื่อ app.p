import os
import time
import logging
from datetime import datetime, timezone

import requests
import pandas as pd
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("signal-radar")

API_KEY = os.getenv("TWELVE_DATA_API_KEY", "").strip()
MIN_SCORE = int(os.getenv("MIN_SCORE", "65"))
CACHE_SECONDS = int(os.getenv("CACHE_SECONDS", "20"))

SYMBOLS = [
    "EUR/USD",
    "GBP/USD",
    "USD/JPY",
    "AUD/USD",
    "USD/CAD",
    "EUR/JPY",
]

_cache = {}


def utc_now():
    return datetime.now(timezone.utc)


def fetch_candles(symbol):
    """ดึงแท่งเทียน 1 นาทีจาก Twelve Data จริง ไม่สร้างราคาจำลอง"""
    if not API_KEY:
        raise RuntimeError(
            "ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY ใน Render"
        )

    now = time.time()
    cached = _cache.get(symbol)

    if cached and now - cached["time"] < CACHE_SECONDS:
        return cached["candles"]

    response = requests.get(
        "https://api.twelvedata.com/time_series",
        params={
            "symbol": symbol,
            "interval": "1min",
            "outputsize": 160,
            "timezone": "UTC",
            "apikey": API_KEY,
        },
        timeout=10,
    )
    response.raise_for_status()
    payload = response.json()

    if "values" not in payload:
        raise RuntimeError(
            payload.get("message", "ผู้ให้บริการไม่ส่งข้อมูลราคา")
        )

    df = pd.DataFrame(payload["values"])
    df["datetime"] = pd.to_datetime(
        df["datetime"], utc=True, errors="coerce"
    )

    for col in ["open", "high", "low", "close"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = (
        df.dropna(subset=["datetime", "open", "high", "low", "close"])
        .sort_values("datetime")
        .reset_index(drop=True)
    )

    if len(df) < 60:
        raise RuntimeError("ข้อมูลย้อนหลังไม่เพียงพอ")

    candles = df.to_dict(orient="records")
    _cache[symbol] = {
        "time": now,
        "candles": candles,
    }
    return candles


def calculate_rsi(close, period=14):
    delta = close.diff()
    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)

    avg_gain = gains.ewm(
        alpha=1 / period, min_periods=period, adjust=False
    ).mean()
    avg_loss = losses.ewm(
        alpha=1 / period, min_periods=period, adjust=False
    ).mean()

    rs = avg_gain / avg_loss.replace(0, float("nan"))
    result = 100 - (100 / (1 + rs))
    return result.fillna(50)


def analyze(symbol, candles):
    df = pd.DataFrame(candles).copy()

    close = pd.to_numeric(df["close"])
    high = pd.to_numeric(df["high"])
    low = pd.to_numeric(df["low"])

    ema9 = close.ewm(span=9, adjust=False).mean()
    ema21 = close.ewm(span=21, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean()

    rsi = calculate_rsi(close)
    macd = (
        close.ewm(span=12, adjust=False).mean()
        - close.ewm(span=26, adjust=False).mean()
    )
    macd_signal = macd.ewm(span=9, adjust=False).mean()

    # ใช้แท่งที่ปิดแล้วเท่านั้น ลดการอ่านสัญญาณจากแท่งที่ยังวิ่ง
    now_minute = utc_now().replace(second=0, microsecond=0)
    last = len(df) - 1

    while last >= 0:
        candle_time = df.loc[last, "datetime"].to_pydatetime()
        if candle_time < now_minute:
            break
        last -= 1

    if last < 50:
        raise RuntimeError("ยังไม่มีแท่งที่ปิดแล้วเพียงพอ")

    score = 50.0
    reasons = []

    if ema9.iloc[last] > ema21.iloc[last] > ema50.iloc[last]:
        score += 20
        reasons.append("EMA ขาขึ้น")
        trend = "BULLISH"
    elif ema9.iloc[last] < ema21.iloc[last] < ema50.iloc[last]:
        score -= 20
        reasons.append("EMA ขาลง")
        trend = "BEARISH"
    else:
        trend = "NEUTRAL"
        reasons.append("EMA ยังไม่เรียงตัวชัดเจน")

    if macd.iloc[last] > macd_signal.iloc[last]:
        score += 12
        reasons.append("MACD บวก")
    else:
        score -= 12
        reasons.append("MACD ลบ")

    rsi_value = float(rsi.iloc[last])

    if 50 <= rsi_value <= 68:
        score += 8
        reasons.append("RSI สนับสนุนแรงซื้อ")
    elif 32 <= rsi_value < 50:
        score -= 8
        reasons.append("RSI สนับสนุนแรงขาย")
    elif rsi_value > 75:
        score -= 5
        reasons.append("RSI สูง ระวังแรงขายกลับ")
    elif rsi_value < 25:
        score += 5
        reasons.append("RSI ต่ำ ระวังแรงซื้อกลับ")

    # ลดคะแนนเมื่อความผันผวนผิดปกติ
    candle_range = high - low
    atr = candle_range.rolling(14).mean()
    median_range = candle_range.rolling(30).median()

    a = atr.iloc[last]
    m = median_range.iloc[last]

    if pd.notna(a) and pd.notna(m) and m > 0:
        if a < m * 0.45:
            score = 50 + (score - 50) * 0.55
            reasons.append("ความผันผวนต่ำ ลดคะแนน")
        elif a > m * 3.5:
            score = 50 + (score - 50) * 0.60
            reasons.append("ความผันผวนสูง ลดคะแนน")

    score = max(0, min(100, score))

    if score >= MIN_SCORE:
        signal = "CALL"
        strength = score
    elif score <= 100 - MIN_SCORE:
        signal = "PUT"
        strength = 100 - score
    else:
        signal = "WAIT"
        strength = max(score, 100 - score)

    candle_time = df.loc[last, "datetime"]

    return {
        "symbol": symbol,
        "signal": signal,
        "score": round(float(strength), 1),
        "trend": trend,
        "rsi": round(rsi_value, 2),
        "price": float(close.iloc[last]),
        "candle_time": candle_time.isoformat(),
        "reasons": reasons,
    }


@app.get("/")
def index():
    return render_template("index.html", symbols=SYMBOLS)


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "provider": "Twelve Data",
        "configured": bool(API_KEY),
        "time": utc_now().isoformat(),
    })


@app.get("/api/status")
def status():
    return jsonify({
        "ok": True,
        "provider": "Twelve Data",
        "configured": bool(API_KEY),
        "timeframe": "1m",
        "minimum_score": MIN_SCORE,
    })


@app.get("/api/signals")
def signals():
    requested = request.args.get("symbol", "AUTO").strip().upper()

    if requested == "AUTO":
        targets = SYMBOLS
    else:
        normalized = requested.replace("-", "/")
        if normalized not in SYMBOLS:
            return jsonify({
                "ok": False,
                "error": "ไม่รองรับคู่เงินนี้",
                "signals": [],
            }), 400
        targets = [normalized]

    results = []
    errors = []

    for symbol in targets:
        try:
            candles = fetch_candles(symbol)
            results.append(analyze(symbol, candles))
        except Exception as exc:
            logger.warning("Scan failed for %s: %s", symbol, exc)
            errors.append({
                "symbol": symbol,
                "error": str(exc)[:180],
            })

    results.sort(
        key=lambda item: (
            item["signal"] == "WAIT",
            -item["score"],
        )
    )

    return jsonify({
        "ok": bool(results),
        "provider": "Twelve Data",
        "timeframe": "1m",
        "server_time": utc_now().isoformat(),
        "signals": results,
        "errors": errors,
        "message": (
            None if results else
            "ไม่มีข้อมูลราคา กรุณาตรวจสอบ API Key และโควตา"
        ),
    })


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "10000")),
        debug=False,
    )