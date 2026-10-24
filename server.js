// 🧠 ฟังก์ชันสูตร AI คำนวณจากรูปภาพกราฟ (EUR/USD OTC Trend Momentum)
function analyzePatternFromScreenshot(prices) {
  if (prices.length < 21) return { signal: 'WAIT', confidence: 50.0 };

  const currentPrice = prices[prices.length - 1];
  const prevPrice = prices[prices.length - 2];
  
  const emaFast = calculateEMA(prices, 6);   // เส้นสีเหลือง
  const emaSlow = calculateEMA(prices, 21);  // เส้นสีฟ้า

  // 1. เช็กการตัดกันของเส้น EMA (Trend Check)
  const isUptrend = emaFast > emaSlow;
  const isDowntrend = emaFast < emaSlow;

  // 2. เช็กว่าราคายืนเหนือ/ใต้เส้น EMA หรือไม่ (Breakout/Momentum Check)
  const isBullishCandle = currentPrice > prevPrice && currentPrice > emaFast;
  const isBearishCandle = currentPrice < prevPrice && currentPrice < emaFast;

  // 3. คำนวณความมั่นใจ (Confidence Score)
  const trendGap = Math.abs(emaFast - emaSlow) / currentPrice * 1000;

  if (isUptrend && isBullishCandle) {
    return {
      signal: 'CALL',
      confidence: Math.min(80.0 + (trendGap * 10.0), 95.0),
      label: 'SCREENSHOT PATTERN: UPTREND MOMENTUM 🚀'
    };
  } else if (isDowntrend && isBearishCandle) {
    return {
      signal: 'PUT',
      confidence: Math.min(80.0 + (trendGap * 10.0), 95.0),
      label: 'SCREENSHOT PATTERN: DOWNTREND MOMENTUM 📉'
    };
  }

  return { signal: 'WAIT', confidence: 50.0, label: 'WAITING FOR SCREENSHOT PATTERN' };
}
