# Interview — AI-Powered Live Interview Assistant

A real-time interview assistant that listens to your interview audio, transcribes it live, and generates AI-powered answers to help you prepare and practice. Share your screen or tab audio, upload your resume and job description for context, and get intelligent answers as questions are asked.

Designed for interview preparation and practice sessions — understand what great answers look like for your specific background.

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Express](https://img.shields.io/badge/Express-4.x-lightgrey) ![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **Live audio transcription** — captures tab/screen audio using browser APIs and transcribes in real-time via Deepgram
- **Speaker diarization** — automatically detects and labels different speakers in the conversation
- **AI answer generation** — generates contextual answers using your uploaded documents as reference
- **Document context** — upload your resume (PDF/TXT/MD) and job description for personalized responses
- **Speaker identification** — interactive modal to identify and label speakers
- **Live transcript** — color-coded by speaker with timestamps
- **Picture-in-Picture** — keep the shared tab video visible while working
- **Dark/light theme** — toggle between themes
- **Markdown rendering** — AI answers formatted with full markdown support

## How It Works

1. Upload your resume and/or job description for context
2. Click "Start Listening" and share the browser tab with your interview call
3. Audio is streamed to Deepgram for real-time speech-to-text transcription
4. When a question is detected, AI generates a suggested answer based on your documents and the conversation context
5. Answers appear in real-time with markdown formatting

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [Deepgram API key](https://deepgram.com/) — for real-time speech-to-text (free tier available)
- [OpenRouter API key](https://openrouter.ai/) — for AI answer generation
- A Chromium-based browser (Chrome, Edge, Brave) for tab audio capture

## Quick Start

```bash
git clone https://github.com/zlnsk/interview.git
cd interview
npm install
cp .env.example .env
# Edit .env with your API keys
node server.js
```

Open [http://localhost:3014/Interview](http://localhost:3014/Interview) in your browser.

## API Keys Setup

### Deepgram (Speech-to-Text)

1. Sign up at [deepgram.com](https://deepgram.com/)
2. Create an API key in the dashboard
3. Free tier includes $200 in credit — plenty for practice sessions

### OpenRouter (AI Answers)

1. Sign up at [openrouter.ai](https://openrouter.ai/)
2. Create an API key
3. Powers the AI answer generation using Claude or other models

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | Yes | Deepgram API key for transcription |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for AI |
| `PORT` | No | Server port (default: 3014) |
## Tech Stack

- **Backend:** Node.js, Express, WebSocket (Deepgram streaming)
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **Speech-to-Text:** [Deepgram](https://deepgram.com/) (WebSocket streaming)
- **AI:** [OpenRouter](https://openrouter.ai/) (Claude/GPT models)
- **Markdown:** marked.js

## License

MIT
