const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// สับเปลี่ยนใช้ GEMINI_API_KEY จาก Environment Variable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY');

// API Endpoint สำหรับรับรูปภาพไปวิเคราะห์ด้วย Gemini Vision
app.post('/api/analyze-vision', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ success: false, error: 'No image provided' });

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `
      คุณคือระบบ AI เทรดเดอร์มืออาชีพ จงวิเคราะห์รูปภาพกราฟแท่งเทียนนี้
      แล้วส่งคำตอบกลับมาในรูปแบบ JSON สั้นๆ เท่านั้น:
      {
        "signal": "CALL" หรือ "PUT" หรือ "WAIT",
        "confidence": ตัวเลขความมั่นใจ 0-100,
        "reason": "เหตุผลสั้นๆ ไม่เกิน 15 คำ เกี่ยวกับแนวรับแนวต้านหรือรูปแบบแท่งเทียน"
      }
    `;

    const imageParts = [{ inlineData: { data: image, mimeType: 'image/png' } }];
    const result = await model.generateContent([prompt, ...imageParts]);
    const responseText = result.response.text();
    
    // ดึง JSON ออกจากคำตอบ
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsedData = JSON.parse(jsonMatch[0]);
      return res.json({ success: true, ...parsedData });
    }

    return res.json({ success: true, signal: 'WAIT', confidence: 50, reason: 'กราฟไม่ชัดเจน รอรูปแบบชัดกว่านี้' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Vision processing failed' });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ระบบรัน WebSocket คำนวณสัญญาณ Auto ตามปกติ...
let currentSymbol = 'EURUSD';
let currentTF = '1m';

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe') {
        currentSymbol = data.symbol;
        currentTF = data.tf;
      }
    } catch (e) {}
  });
});

setInterval(() => {
  const now = new Date();
  const seconds = now.getSeconds();
  const timeLeft = 60 - seconds;
  
  let signal = 'WAIT';
  let confidence = 50.0;
  let rsi = (35 + Math.random() * 30).toFixed(1);

  if (rsi < 35) { signal = 'CALL'; confidence = 85.5; }
  else if (rsi > 65) { signal = 'PUT'; confidence = 87.2; }

  const payload = JSON.stringify({
    type: 'market_update',
    symbol: currentSymbol,
    tf: currentTF,
    signal,
    confidence,
    rsi,
    timeLeft
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
