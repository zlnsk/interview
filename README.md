# InterviewAssist

AI-powered live interview assistant. Streams microphone audio to
[Deepgram](https://deepgram.com) for real-time transcription, then feeds the
interviewer's question plus your uploaded resume and job description to a
large language model (via [OpenRouter](https://openrouter.ai)) to generate a
concise, first-person answer you can read while the interview is happening.

## Features

- Live speech-to-text via Deepgram Nova-3 (diarization, interim results)
- Contextual answers grounded in your own CV + job description
- Choice of Claude Sonnet or Claude Opus models
- Streaming responses (Server-Sent Events)
- Simple document upload (PDF, TXT, MD)

## Environment variables

Copy `.env.example` to `.env` (or use `ecosystem.config.example` with PM2)
and fill in:

- `PORT` - HTTP port (default 3014)
- `APP_URL` - public URL of the app, sent as `HTTP-Referer` to OpenRouter
- `DEEPGRAM_API_KEY` - required for transcription
- `OPENROUTER_API_KEY` - required for answer generation

## Upload your own CV

1. Start the app and open it in your browser.
2. Use the upload panel to drop in your resume PDF and the job description.
3. The server extracts text with `pdf-parse` and stores metadata in
   `uploads/meta.json`. This directory is git-ignored - your CV never leaves
   the machine.

## Install & run

```bash
npm install
cp .env.example .env   # fill in keys
node server.js
```

Or with PM2: `cp ecosystem.config.example ecosystem.config.js && pm2 start ecosystem.config.js`.
