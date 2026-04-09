require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

const PORT = process.env.PORT || 3014;
const BASE_PATH = '/Interview';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// --- Document Upload ---
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

const documents = new Map();

function loadExistingDocs() {
  const metaPath = path.join(__dirname, 'uploads', 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      for (const doc of meta) {
        documents.set(doc.id, doc);
      }
      console.log(`Loaded ${documents.size} documents from disk`);
    } catch (e) {
      console.error('Failed to load doc metadata:', e);
    }
  }
}
loadExistingDocs();

function saveMeta() {
  const metaPath = path.join(__dirname, 'uploads', 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify([...documents.values()], null, 2));
}

app.post(`${BASE_PATH}/api/upload`, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  let text = '';

  try {
    if (ext === '.pdf') {
      const buf = fs.readFileSync(req.file.path);
      const data = await pdfParse(buf);
      text = data.text;
    } else {
      text = fs.readFileSync(req.file.path, 'utf8');
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to parse file' });
  }

  const doc = {
    id: req.file.filename,
    name: req.file.originalname,
    type: req.body.type || 'other',
    text: text,
    uploadedAt: new Date().toISOString()
  };

  documents.set(doc.id, doc);
  saveMeta();

  res.json({ id: doc.id, name: doc.name, type: doc.type });
});

app.get(`${BASE_PATH}/api/documents`, (req, res) => {
  const docs = [...documents.values()].map(d => ({
    id: d.id, name: d.name, type: d.type, uploadedAt: d.uploadedAt
  }));
  res.json(docs);
});

app.delete(`${BASE_PATH}/api/documents/:id`, (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(__dirname, 'uploads', doc.id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  documents.delete(doc.id);
  saveMeta();

  res.json({ ok: true });
});

// --- AI Answer Generation ---
app.post(`${BASE_PATH}/api/answer`, async (req, res) => {
  const { question, transcript, model } = req.body;
  console.log(`Answer request: q="${(question||'').slice(0,60)}" model=${model}`);
  if (!question) return res.status(400).json({ error: 'No question' });

  const apiKey = OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

  const docTexts = [...documents.values()]
    .map(d => `--- ${d.type.toUpperCase()}: ${d.name} ---\n${d.text}`)
    .join('\n\n');

  const systemPrompt = `You are a live interview assistant. Be concise — the user reads this during the interview.

Rules:
- First person, as if the user is speaking
- MAX 90 words for simple questions, 130 for behavioral/STAR
- Draw from uploaded documents for concrete examples
- Never say "I don't know" — always give a strong answer
- Go straight to the point, no filler or preamble
- IMPORTANT: briefly explain every technical keyword you mention — don't assume the reader knows acronyms or jargon. E.g. "**Service Bus** (cloud message broker)" or "**pub/sub** (publish/subscribe pattern)"

Format:
- **Bold** key terms only
- Bullet points for lists (max 3-4 bullets)
- ### headers only for STAR answers (Situation / Action / Result)
- No walls of text — every word must earn its place

DOCUMENTS:
${docTexts || '(No documents uploaded yet)'}`;

  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  if (transcript) {
    messages.push({ role: 'user', content: `Recent interview transcript:\n${transcript}` });
  }

  messages.push({ role: 'user', content: `The interviewer just asked: "${question}"\n\nProvide a strong answer I can use:` });

  const selectedModel = model === 'opus' ? 'anthropic/claude-opus-4-6' : 'anthropic/claude-sonnet-4-6';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Abort fetch if client disconnects while streaming
  const abortController = new AbortController();
  let streaming = true;
  res.on('close', () => { if (streaming) abortController.abort(); });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `http://localhost:${PORT}/Interview`,
        'X-Title': 'Interview Assistant'
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        stream: true,
        max_tokens: 1024,
        temperature: 0.3
      }),
      signal: abortController.signal
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          break;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    }
  }

  streaming = false;
  res.end();
});

// --- WebSocket upgrade ---
server.on('upgrade', (req, socket, head) => {
  if (req.url !== `${BASE_PATH}/ws`) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// --- WebSocket: Audio → Deepgram → Transcript ---
wss.on('connection', (clientWs) => {
  console.log('Client connected');
  let deepgramWs = null;
  let keepAliveInterval = null;

  clientWs.on('message', (msg) => {
    if (typeof msg === 'string' || (msg instanceof Buffer && msg[0] === 0x7b)) {
      try {
        const ctrl = JSON.parse(msg.toString());
        if (ctrl.type === 'start') {
          startDeepgram(ctrl);
          return;
        }
        if (ctrl.type === 'stop') {
          stopDeepgram();
          return;
        }
      } catch (e) {}
    }

    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.send(msg);
    }
  });

  function startDeepgram(config) {
    if (deepgramWs) stopDeepgram();

    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
      interim_results: 'true',
      utterance_end_ms: '3000',
      endpointing: '800',
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: config.sampleRate || '16000',
      channels: '1',
      filler_words: 'true',
      multichannel: 'false'
    });

    const url = `wss://api.deepgram.com/v1/listen?${params}`;

    deepgramWs = new WebSocket(url, {
      headers: { 'Authorization': `Token ${DEEPGRAM_API_KEY}` }
    });

    deepgramWs.on('open', () => {
      console.log('Deepgram connected');
      clientWs.send(JSON.stringify({ type: 'status', status: 'connected' }));

      keepAliveInterval = setInterval(() => {
        if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 10000);
    });

    deepgramWs.on('message', (data) => {
      try {
        const result = JSON.parse(data.toString());
        clientWs.send(JSON.stringify(result));
      } catch (e) {}
    });

    deepgramWs.on('close', () => {
      console.log('Deepgram disconnected');
      clearInterval(keepAliveInterval);
      clientWs.send(JSON.stringify({ type: 'status', status: 'disconnected' }));
    });

    deepgramWs.on('error', (err) => {
      console.error('Deepgram error:', err.message);
      clientWs.send(JSON.stringify({ type: 'error', error: err.message }));
    });
  }

  function stopDeepgram() {
    clearInterval(keepAliveInterval);
    if (deepgramWs) {
      deepgramWs.close();
      deepgramWs = null;
    }
  }

  clientWs.on('close', () => {
    console.log('Client disconnected');
    stopDeepgram();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`InterviewAssist running on port ${PORT}`);
});
