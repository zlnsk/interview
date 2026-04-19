// =============================================================================
// State
// =============================================================================
const state = {
  ws: null,
  mediaStream: null,
  audioContext: null,
  processor: null,
  isCapturing: false,
  mySpeaker: null,
  speakers: new Map(),       // speakerId -> { lastText, firstSeenAt }
  utterances: [],            // { speaker, text, isFinal, timestamp }
  documents: [],
  enabledDocIds: new Set(),  // empty = all
  pendingQuestion: null,
  questionDebounce: null,
  lastAnsweredQuestion: null,
  lastAnswerTime: 0,
  lastAnswerText: '',        // for clipboard copy + refinement
  lastAnswerCard: null,      // DOM ref to most recent answer card
  speakerModalShown: false,
  mode: 'answer',
  personas: [],
  selectedPersona: '',
  ragMode: false,
  pipWindow: null,           // Document PiP window for answers
  speakerStrategy: 'manual', // 'manual' | 'second_speaker'
  todayCost: 0,
};

// =============================================================================
// DOM helpers
// =============================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const btnCapture = $('#btnCapture');
const btnStop = $('#btnStop');
const btnMenu = $('#btnMenu');
const btnPip = $('#btnPip');
const btnCloseDrawer = $('#btnCloseDrawer');
const btnClearAnswers = $('#btnClearAnswers');
const statusPill = $('#statusPill');
const transcriptEl = $('#transcript');
const answersEl = $('#answers');
const menuDrawer = $('#menuDrawer');
const docsList = $('#docsList');
const uploadForm = $('#uploadForm');
const fileInput = $('#fileInput');
const modelSelect = $('#modelSelect');
const personaSelect = $('#personaSelect');
const speakerModal = $('#speakerModal');
const speakerOptions = $('#speakerOptions');
const btnSkipSpeaker = $('#btnSkipSpeaker');
const speakerLegend = $('#speakerLegend');
const usagePill = $('#usagePill');
const ragToggle = $('#ragToggle');
const personaForm = $('#personaForm');
const personasList = $('#personasList');
const sessionsList = $('#sessionsList');
const usageStats = $('#usageStats');
const recapModal = $('#recapModal');
const recapOutput = $('#recapOutput');
const helpModal = $('#helpModal');
const autoPickSpeaker = $('#autoPickSpeaker');

function setStatus(text, type = '') {
  // Keep shared M3 chip classes; only toggle semantic state classes.
  statusPill.className = 'm3-chip status-chip' + (type ? ' ' + type : '');
  if (type === 'active') statusPill.setAttribute('data-selected', 'true');
  else statusPill.removeAttribute('data-selected');
  statusPill.querySelector('.label').textContent = text;
}
function scrollToBottom(el) { el.scrollTop = el.scrollHeight; }
function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
const esc = escapeHtml;
function renderMarkdown(text) {
  if (typeof marked !== 'undefined') return marked.parse(text, { breaks: true });
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// =============================================================================
// Audio capture (existing)
// =============================================================================
btnCapture.addEventListener('click', startCapture);
btnStop.addEventListener('click', stopCapture);

async function startCapture() {
  try {
    state.mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
    });
    const audioTracks = state.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      alert('No audio track shared. Make sure to check "Share tab audio" in the dialog.');
      state.mediaStream.getTracks().forEach(t => t.stop());
      return;
    }
    const videoTracks = state.mediaStream.getVideoTracks();
    if (videoTracks.length > 0) {
      const pipVideo = document.getElementById('pipVideo');
      pipVideo.srcObject = new MediaStream(videoTracks);
      pipVideo.play().then(() => {
        pipVideo.requestPictureInPicture().catch(() => {
          document.getElementById('pipContainer').classList.remove('hidden');
        });
      });
      pipVideo.addEventListener('enterpictureinpicture', () => {
        document.getElementById('pipContainer').classList.add('hidden');
      });
      pipVideo.addEventListener('leavepictureinpicture', () => {
        document.getElementById('pipContainer').classList.remove('hidden');
      });
    }
    state.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = state.audioContext.createMediaStreamSource(new MediaStream(audioTracks));
    state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = (e) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        state.ws.send(int16.buffer);
      }
    };
    source.connect(state.processor);
    state.processor.connect(state.audioContext.destination);
    connectWS();
    state.isCapturing = true;
    btnCapture.style.display = 'none';
    btnStop.style.display = 'flex';
    setStatus('Connecting...', '');
    transcriptEl.innerHTML = '';
    audioTracks[0].onended = () => stopCapture();
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      console.error('Capture error:', err);
      alert('Failed to capture audio: ' + err.message);
    }
  }
}

function stopCapture() {
  state.isCapturing = false;
  const pipVideo = document.getElementById('pipVideo');
  if (document.pictureInPictureElement === pipVideo) {
    document.exitPictureInPicture().catch(() => {});
  }
  pipVideo.srcObject = null;
  document.getElementById('pipContainer').classList.add('hidden');
  if (state.mediaStream) { state.mediaStream.getTracks().forEach(t => t.stop()); state.mediaStream = null; }
  if (state.processor) { state.processor.disconnect(); state.processor = null; }
  if (state.audioContext) { state.audioContext.close(); state.audioContext = null; }
  if (state.ws) {
    try { state.ws.send(JSON.stringify({ type: 'stop' })); } catch {}
    state.ws.close();
    state.ws = null;
  }
  btnCapture.style.display = 'flex';
  btnStop.style.display = 'none';
  setStatus('Stopped', '');
}

// =============================================================================
// WebSocket / Deepgram (existing)
// =============================================================================
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/Interview/ws`);
  state.ws.onopen = () => state.ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
  state.ws.onmessage = (evt) => handleDeepgramMessage(JSON.parse(evt.data));
  state.ws.onclose = () => {
    if (state.isCapturing) {
      setStatus('Reconnecting...', 'error');
      setTimeout(connectWS, 2000);
    }
  };
  state.ws.onerror = () => setStatus('Connection error', 'error');
}

let currentUtteranceEl = null;

function handleDeepgramMessage(data) {
  if (data.type === 'status') {
    if (data.status === 'connected') setStatus('Listening', 'active');
    else if (data.status === 'disconnected') setStatus('Disconnected', 'error');
    return;
  }
  if (data.type === 'error') { setStatus('Error: ' + data.error, 'error'); return; }
  if (data.type === 'Results' && data.channel) {
    const alt = data.channel.alternatives[0];
    if (!alt || !alt.transcript) return;
    const transcript = alt.transcript.trim();
    if (!transcript) return;
    const isFinal = data.is_final;
    const speaker = alt.words?.[0]?.speaker ?? -1;
    if (speaker >= 0 && !state.speakers.has(speaker)) {
      state.speakers.set(speaker, { lastText: transcript, firstSeenAt: Date.now() });
      updateSpeakerLegend();
      // Speaker auto-pick: if strategy says "second speaker is me"
      if (state.speakers.size >= 2 && state.mySpeaker == null && state.speakerStrategy === 'second_speaker') {
        const sorted = [...state.speakers.entries()].sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt);
        state.mySpeaker = sorted[1][0];
        updateSpeakerLegend();
        reRenderTranscript();
      } else if (state.speakers.size >= 2 && !state.speakerModalShown && state.mySpeaker == null) {
        state.speakerModalShown = true;
        setTimeout(showSpeakerModal, 1000);
      }
    }
    if (isFinal) {
      if (currentUtteranceEl) { currentUtteranceEl.remove(); currentUtteranceEl = null; }
      const lastUtt = state.utterances[state.utterances.length - 1];
      if (lastUtt && lastUtt.speaker === speaker && (Date.now() - lastUtt.timestamp) < 8000) {
        lastUtt.text += ' ' + transcript;
        lastUtt.timestamp = Date.now();
        const lastEl = transcriptEl.querySelector('.utterance:last-child');
        if (lastEl) lastEl.querySelector('.text').textContent = lastUtt.text;
      } else {
        addUtterance(speaker, transcript, true);
      }
      scrollToBottom(transcriptEl);

      // Detect refinement intent FIRST (so "make it shorter" is refinement, not new Q)
      if (speaker === state.mySpeaker && state.lastAnswerText) {
        const ref = detectRefinementClient(transcript);
        if (ref) {
          generateAnswer(state.lastAnsweredQuestion || transcript, { refinement: ref });
          return;
        }
      }
      // Detect questions from non-me speakers
      if (speaker !== state.mySpeaker && isQuestionHeuristic(transcript)) {
        scheduleAnswer(extractQuestion(transcript));
      } else if (speaker !== state.mySpeaker && state.pendingQuestion && state.questionDebounce) {
        state.pendingQuestion += ' ' + transcript;
      }
    } else {
      if (!currentUtteranceEl) {
        currentUtteranceEl = createUtteranceEl(speaker, transcript, false);
        transcriptEl.appendChild(currentUtteranceEl);
      } else {
        currentUtteranceEl.querySelector('.text').textContent = transcript;
      }
      scrollToBottom(transcriptEl);
    }
  }
  if (data.type === 'UtteranceEnd') currentUtteranceEl = null;
}

function addUtterance(speaker, text, isFinal) {
  state.utterances.push({ speaker, text, isFinal, timestamp: Date.now() });
  const el = createUtteranceEl(speaker, text, isFinal);
  transcriptEl.appendChild(el);
  scrollToBottom(transcriptEl);
  const empty = transcriptEl.querySelector('.empty-state');
  if (empty) empty.remove();
}

function createUtteranceEl(speaker, text, isFinal) {
  const el = document.createElement('div');
  const speakerClass = speaker >= 0 ? `speaker-${speaker % 4}` : '';
  const isMe = speaker === state.mySpeaker;
  el.className = `utterance ${speakerClass} ${isFinal ? '' : 'interim'} ${isMe ? 'is-me' : ''}`;
  const label = isMe ? 'You' : `Speaker ${speaker + 1}`;
  const badge = isMe
    ? '<span class="badge you">YOU</span>'
    : '<span class="badge">INTERVIEWER</span>';
  const tagDiv = document.createElement('div');
  tagDiv.className = 'speaker-tag';
  tagDiv.innerHTML = `${esc(label)} ${badge}`;
  const textDiv = document.createElement('div');
  textDiv.className = 'text';
  textDiv.textContent = text;
  el.appendChild(tagDiv);
  el.appendChild(textDiv);
  return el;
}

// =============================================================================
// Question detection (heuristic + optional classifier gating)
// =============================================================================
const Q_WORDS = ['what', 'why', 'how', 'when', 'where', 'who', 'which', 'can you', 'could you', 'tell me', 'describe', 'explain', 'walk me through', 'give me', 'do you', 'have you', 'are you', 'is there', 'would you'];
const Q_MARKERS = ['next question is', 'my next question', 'can i ask', 'question for you', 'i want to ask'];

function _splitSegments(text) {
  // Split on sentence terminators, then further split on question markers.
  const parts = text.split(/[.?!]+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    let markerIdx = -1;
    let markerLen = 0;
    for (const m of Q_MARKERS) {
      const i = lower.indexOf(m);
      if (i !== -1 && (markerIdx === -1 || i < markerIdx)) {
        markerIdx = i;
        markerLen = m.length;
      }
    }
    if (markerIdx !== -1) {
      const before = part.slice(0, markerIdx).trim();
      const after = part.slice(markerIdx + markerLen).trim();
      if (before) out.push(before);
      if (after) out.push(after);
    } else {
      out.push(part);
    }
  }
  return out.map(s => s.replace(/^[,"'\s]+|[,"'\s]+$/g, '')).filter(Boolean);
}

function _segmentLooksLikeQuestion(seg) {
  if (!seg) return false;
  const wordCount = seg.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;
  const lower = seg.toLowerCase();
  return Q_WORDS.some(w => lower.startsWith(w));
}

function isQuestionHeuristic(text) {
  if (!text) return false;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  // Fast paths
  if (lower.endsWith('?')) return true;
  if (trimmed.includes('?')) return true;
  if (Q_WORDS.some(w => lower.startsWith(w))) return true;
  // Mid-sentence: check each segment
  const segments = _splitSegments(trimmed);
  return segments.some(_segmentLooksLikeQuestion);
}

function extractQuestion(text) {
  if (!text) return text;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  // If whole thing already looks like a question, return as-is.
  if (lower.endsWith('?') || Q_WORDS.some(w => lower.startsWith(w))) return trimmed;
  // Prefer a Q-word-starting segment (this also strips leading markers like
  // "next question is,") — gives the cleanest question to the LLM.
  const segments = _splitSegments(trimmed);
  for (const seg of segments) {
    if (_segmentLooksLikeQuestion(seg)) {
      // If this segment has no trailing '?' but the original does, append one.
      if (!seg.endsWith('?') && trimmed.includes('?')) return seg + '?';
      return seg;
    }
  }
  // Fallback: find a literal '?' and return the sentence ending there.
  const qIdx = trimmed.indexOf('?');
  if (qIdx !== -1) {
    let start = 0;
    for (let i = qIdx - 1; i >= 0; i--) {
      if (/[.?!]/.test(trimmed[i])) { start = i + 1; break; }
    }
    const seg = trimmed.slice(start, qIdx + 1).trim();
    if (seg.split(/\s+/).filter(Boolean).length >= 3) return seg;
  }
  return trimmed;
}

// Refinement intent detection (client-side, regex)
function detectRefinementClient(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (/(make|say|do).*(short|brief|concise)/.test(t) || /\bshorter\b/.test(t)) return 'shorter';
  if (/(longer|more detail|expand|elaborate)/.test(t)) return 'longer';
  if (/(more confident|less hedging|stronger|assertive)/.test(t)) return 'more_confident';
  if (/(casual|informal|conversational)/.test(t)) return 'more_casual';
  if (/(rephrase|reword|different way|other way)/.test(t)) return 'rephrase';
  if (/(give.*example|concrete example|specific example)/.test(t)) return 'example';
  if (/(simpler|simplify|non.?technical|less jargon)/.test(t)) return 'simpler';
  return null;
}

function scheduleAnswer(question) {
  if (state.lastAnswerTime && (Date.now() - state.lastAnswerTime) < 3000) return;
  if (state.lastAnsweredQuestion) {
    const prev = state.lastAnsweredQuestion.toLowerCase();
    const curr = question.toLowerCase();
    if (curr === prev || prev.includes(curr) || curr.includes(prev)) return;
    const prevWords = new Set(prev.split(/\s+/));
    const currWords = curr.split(/\s+/);
    const overlap = currWords.filter(w => prevWords.has(w)).length;
    if (overlap > currWords.length * 0.5) return;
  }
  clearTimeout(state.questionDebounce);
  state.pendingQuestion = question;
  state.questionDebounce = setTimeout(() => {
    state.lastAnsweredQuestion = state.pendingQuestion;
    state.lastAnswerTime = Date.now();
    generateAnswer(state.pendingQuestion);
  }, 2500);
}

// =============================================================================
// Answer generation — supports modes, refinements, RAG, persona, usage
// =============================================================================
async function generateAnswer(question, opts = {}) {
  const recentTranscript = state.utterances
    .slice(-20)
    .map(u => {
      const label = u.speaker === state.mySpeaker ? 'Me' : `Speaker ${u.speaker + 1}`;
      return `${label}: ${u.text}`;
    })
    .join('\n');

  const model = modelSelect.value;
  const mode = opts.mode || state.mode;
  const refinement = opts.refinement || null;

  // Create answer card
  const card = document.createElement('div');
  card.className = 'answer-card' + (refinement ? ' refinement' : '');
  const headerLabel = refinement ? `Refining: ${refinement.replace(/_/g, ' ')}` : esc(question);
  card.innerHTML = `
    <div class="question">${refinement ? '<em>' + headerLabel + '</em>' : headerLabel}</div>
    <div class="answer-text"><span class="cursor"></span></div>
    <div class="answer-toolbar">
      <button class="chip-mini" data-ref="shorter" title="R — shorter">Shorter</button>
      <button class="chip-mini" data-ref="longer" title="Shift+R — longer">Longer</button>
      <button class="chip-mini" data-ref="example" title="E — add example">+ Example</button>
      <button class="chip-mini" data-ref="more_confident">More confident</button>
      <button class="chip-mini" data-ref="simpler" title="S — simpler">Simpler</button>
      <button class="chip-mini" data-ref="rephrase">Rephrase</button>
      <button class="chip-mini copy" title="Y — copy">Copy</button>
    </div>
    <div class="meta">
      <span class="meta-mode">${mode}</span>
      <span class="meta-model">${model === 'opus' ? 'Opus 4.6' : model === 'haiku' ? 'Haiku 4.5' : 'Sonnet 4.6'}</span>
      <span class="meta-time">${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
      <span class="meta-cost"></span>
    </div>
  `;
  const empty = answersEl.querySelector('.empty-state');
  if (empty) empty.remove();
  answersEl.insertBefore(card, answersEl.firstChild);
  state.lastAnswerCard = card;

  const textEl = card.querySelector('.answer-text');
  const costEl = card.querySelector('.meta-cost');

  // Coalesce markdown re-renders into one per animation frame so streaming a
  // 400-token answer doesn't trigger 400 marked.parse() + innerHTML thrashes.
  let fullText = '';
  let renderPending = false;
  const flushRender = () => {
    renderPending = false;
    textEl.innerHTML = renderMarkdown(fullText) + '<span class="cursor"></span>';
    if (state.pipWindow) renderPip();
  };
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(flushRender);
  };

  // Wire toolbar buttons (refinement)
  card.querySelectorAll('[data-ref]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ref = btn.dataset.ref;
      generateAnswer(state.lastAnsweredQuestion || question, { refinement: ref });
    });
  });
  card.querySelector('.copy').addEventListener('click', () => copyToClipboard(state.lastAnswerText));

  try {
    const res = await fetch('/Interview/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        transcript: recentTranscript,
        model,
        mode,
        refinement,
        persona: state.selectedPersona || null,
        useRag: state.ragMode,
        enabledDocIds: state.enabledDocIds.size > 0 ? [...state.enabledDocIds] : undefined,
      })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = evt.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              fullText += parsed.text;
              scheduleRender();
            }
            if (parsed.usage) {
              const c = parsed.usage.cost || 0;
              costEl.textContent = `$${c.toFixed(4)} · ${parsed.usage.ttftMs || '?'}ms ttft`;
              state.todayCost += c;
              updateUsagePill();
            }
            if (parsed.error) {
              textEl.innerHTML = `<span style="color:var(--danger)">Error: ${escapeHtml(parsed.error)}</span>`;
            }
          } catch (e) {}
        }
      }
    }
    textEl.innerHTML = renderMarkdown(fullText);
    state.lastAnswerText = fullText;
    if (state.pipWindow) renderPip();
  } catch (err) {
    textEl.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(err.message)}</span>`;
  }
}

function copyToClipboard(text) {
  if (!text) return;
  // Strip markdown to plain text for the clipboard
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMarkdown(text);
  const plain = tmp.textContent || text;
  navigator.clipboard.writeText(plain).then(() => {
    setStatus('Copied', 'active');
    setTimeout(() => state.isCapturing ? setStatus('Listening', 'active') : setStatus('Ready', ''), 1200);
  });
}

function updateUsagePill() {
  usagePill.textContent = `$${state.todayCost.toFixed(2)} today`;
}

// =============================================================================
// Mode chips
// =============================================================================
$$('#modeChips .mode-btn').forEach(chip => {
  chip.addEventListener('click', () => setMode(chip.dataset.mode));
});

function setMode(mode) {
  state.mode = mode;
  $$('#modeChips .mode-btn').forEach(c => c.classList.toggle('active', c.dataset.mode === mode));
}

// =============================================================================
// Speaker selection
// =============================================================================
function showSpeakerModal() {
  speakerOptions.innerHTML = '';
  for (const [id, info] of state.speakers) {
    const btn = document.createElement('button');
    btn.textContent = `Speaker ${id + 1} — "${info.lastText?.slice(0, 60) || '...'}"`;
    btn.onclick = () => {
      state.mySpeaker = id;
      speakerModal.classList.add('hidden');
      // Persist strategy if user opted in
      if (autoPickSpeaker.checked) {
        state.speakerStrategy = 'second_speaker';
        fetch('/Interview/api/speaker-prefs', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strategy: 'second_speaker' })
        });
      }
      updateSpeakerLegend();
      reRenderTranscript();
    };
    speakerOptions.appendChild(btn);
  }
  speakerModal.classList.remove('hidden');
}

btnSkipSpeaker.addEventListener('click', () => speakerModal.classList.add('hidden'));

function updateSpeakerLegend() {
  speakerLegend.innerHTML = '';
  const colors = ['var(--blue)', 'var(--purple)', 'var(--orange)', 'var(--green)'];
  for (const [id] of state.speakers) {
    const isMe = id === state.mySpeaker;
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:${colors[id % 4]}"></span>${isMe ? 'You' : 'Speaker ' + (id + 1)}`;
    item.onclick = () => {
      state.mySpeaker = id;
      updateSpeakerLegend();
      reRenderTranscript();
    };
    speakerLegend.appendChild(item);
  }
}

function reRenderTranscript() {
  transcriptEl.innerHTML = '';
  for (const u of state.utterances) {
    const el = createUtteranceEl(u.speaker, u.text, true);
    transcriptEl.appendChild(el);
  }
  scrollToBottom(transcriptEl);
}

// =============================================================================
// Documents
// =============================================================================
btnMenu.addEventListener('click', () => {
  menuDrawer.classList.toggle('hidden');
  if (!menuDrawer.classList.contains('hidden')) refreshActiveTab();
});
btnCloseDrawer.addEventListener('click', () => menuDrawer.classList.add('hidden'));

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files[0]) return;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('type', $('#docType').value);
  try {
    const res = await fetch('/Interview/api/upload', { method: 'POST', body: formData });
    const doc = await res.json();
    if (doc.error) { alert(doc.error); return; }
    fileInput.value = '';
    loadDocuments();
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
});

ragToggle.addEventListener('change', () => { state.ragMode = ragToggle.checked; });

async function loadDocuments() {
  try {
    const res = await fetch('/Interview/api/documents');
    state.documents = await res.json();
    renderDocsList();
  } catch (err) { console.error('Failed to load docs:', err); }
}

function renderDocsList() {
  if (state.documents.length === 0) {
    docsList.innerHTML = '<p class="hint-text">No documents uploaded yet.</p>';
    return;
  }
  docsList.innerHTML = state.documents.map(doc => {
    const enabled = state.enabledDocIds.size === 0 || state.enabledDocIds.has(doc.id);
    return `
      <div class="doc-item">
        <label class="doc-toggle">
          <input type="checkbox" data-doc="${doc.id}" ${enabled ? 'checked' : ''}>
          <div class="doc-info">
            <span class="doc-name">${escapeHtml(doc.name)}</span>
            <span class="doc-type">${escapeHtml(doc.type.replace('_', ' '))} · ${doc.chars || 0} chars · ${doc.chunks || 0} chunks</span>
          </div>
        </label>
        <button class="btn-delete" data-del="${doc.id}">Remove</button>
      </div>
    `;
  }).join('');
  docsList.querySelectorAll('input[data-doc]').forEach(cb => {
    cb.addEventListener('change', () => {
      // First time the user touches a checkbox, freeze the explicit set
      if (state.enabledDocIds.size === 0) {
        state.documents.forEach(d => state.enabledDocIds.add(d.id));
      }
      if (cb.checked) state.enabledDocIds.add(cb.dataset.doc);
      else state.enabledDocIds.delete(cb.dataset.doc);
      // If everything is on, reset to "all" mode
      if (state.enabledDocIds.size === state.documents.length) {
        state.enabledDocIds.clear();
      }
    });
  });
  docsList.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteDoc(btn.dataset.del));
  });
}

async function deleteDoc(id) {
  try {
    await fetch(`/Interview/api/documents/${id}`, { method: 'DELETE' });
    state.enabledDocIds.delete(id);
    loadDocuments();
  } catch (err) { alert('Delete failed: ' + err.message); }
}

// =============================================================================
// Personas
// =============================================================================
async function loadPersonas() {
  const res = await fetch('/Interview/api/personas');
  const data = await res.json();
  state.personas = data.personas || [];
  renderPersonas();
  renderPersonaSelect();
}

function renderPersonas() {
  if (!personasList) return;
  if (state.personas.length === 0) {
    personasList.innerHTML = '<p class="hint-text">No personas saved yet.</p>';
    return;
  }
  personasList.innerHTML = state.personas.map(p => `
    <div class="doc-item">
      <div class="doc-info">
        <span class="doc-name">${escapeHtml(p.name)}</span>
        <span class="doc-type">${escapeHtml(p.defaultMode || 'answer')} · ${escapeHtml(p.model || 'sonnet')}</span>
      </div>
      <div class="row">
        <button class="btn-ghost" data-edit="${p.id}">Edit</button>
        <button class="btn-delete" data-del-persona="${p.id}">Remove</button>
      </div>
    </div>
  `).join('');
  personasList.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editPersona(b.dataset.edit)));
  personasList.querySelectorAll('[data-del-persona]').forEach(b => b.addEventListener('click', () => deletePersona(b.dataset.delPersona)));
}

function renderPersonaSelect() {
  if (!personaSelect) return;
  personaSelect.innerHTML = '<option value="">Default</option>' +
    state.personas.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  personaSelect.value = state.selectedPersona || '';
}

personaSelect?.addEventListener('change', () => { state.selectedPersona = personaSelect.value; });

function editPersona(id) {
  const p = state.personas.find(x => x.id === id);
  if (!p) return;
  $('#personaId').value = p.id;
  $('#personaName').value = p.name;
  $('#personaPrompt').value = p.prompt;
  $('#personaModel').value = p.model || 'sonnet';
  $('#personaDefaultMode').value = p.defaultMode || 'answer';
}

async function deletePersona(id) {
  if (!confirm('Delete this persona?')) return;
  await fetch(`/Interview/api/personas/${id}`, { method: 'DELETE' });
  if (state.selectedPersona === id) state.selectedPersona = '';
  loadPersonas();
}

if (personaForm) personaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    id: $('#personaId').value || undefined,
    name: $('#personaName').value.trim(),
    prompt: $('#personaPrompt').value.trim(),
    model: $('#personaModel').value,
    defaultMode: $('#personaDefaultMode').value,
  };
  if (!body.name || !body.prompt) return;
  await fetch('/Interview/api/personas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  personaForm.reset();
  $('#personaId').value = '';
  loadPersonas();
});

// =============================================================================


// =============================================================================
// Sessions & Recap
// =============================================================================
async function loadSessions() {
  const res = await fetch('/Interview/api/sessions');
  const data = await res.json();
  if (!sessionsList) return;
  if (!data.sessions || data.sessions.length === 0) {
    sessionsList.innerHTML = '<p class="hint-text">No past sessions yet.</p>';
    return;
  }
  sessionsList.innerHTML = data.sessions.map(s => `
    <div class="session-item">
      <div>
        <div><strong>${new Date(s.startedAt).toLocaleString('en-GB', { hour12: false })}</strong></div>
        <div class="hint-text">${s.questionCount} question${s.questionCount === 1 ? '' : 's'}</div>
      </div>
      <button class="btn-primary btn-sm" data-recap="${escapeHtml(s.sessionId)}">Recap</button>
    </div>
  `).join('');
  sessionsList.querySelectorAll('[data-recap]').forEach(b => {
    b.addEventListener('click', () => generateRecap(b.dataset.recap));
  });
}

async function generateRecap(sessionId) {
  recapModal.classList.remove('hidden');
  recapOutput.innerHTML = '<em>Generating recap…</em>';
  try {
    const res = await fetch('/Interview/api/recap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, model: modelSelect.value }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of evt.split('\n').filter(l => l.startsWith('data: '))) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) { full += parsed.text; recapOutput.innerHTML = renderMarkdown(full); }
          } catch {}
        }
      }
    }
  } catch (e) {
    recapOutput.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(e.message)}</span>`;
  }
}

$('#btnCloseRecap').addEventListener('click', () => recapModal.classList.add('hidden'));

// =============================================================================
// Usage dashboard
// =============================================================================
async function loadUsage() {
  const days = $('#usageRange').value || 7;
  const res = await fetch(`/Interview/api/usage?days=${days}`);
  const data = await res.json();
  if (!usageStats) return;
  const t = data.total;
  const totalIn = (t.in || 0);
  const cacheReadPct = totalIn > 0 ? Math.round(100 * (t.cacheRead || 0) / totalIn) : 0;
  usageStats.innerHTML = `
    <div class="usage-grid">
      <div class="usage-card">
        <div class="usage-card-label">Total cost</div>
        <div class="usage-card-value">$${(t.cost || 0).toFixed(4)}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Requests</div>
        <div class="usage-card-value">${t.requests || 0}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Cache hit</div>
        <div class="usage-card-value">${cacheReadPct}%</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Avg TTFT</div>
        <div class="usage-card-value">${t.avgTtftMs || 0}ms</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Input tokens</div>
        <div class="usage-card-value">${(t.in || 0).toLocaleString()}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Cache read</div>
        <div class="usage-card-value">${(t.cacheRead || 0).toLocaleString()}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Cache write</div>
        <div class="usage-card-value">${(t.cacheWrite || 0).toLocaleString()}</div>
      </div>
      <div class="usage-card">
        <div class="usage-card-label">Output tokens</div>
        <div class="usage-card-value">${(t.out || 0).toLocaleString()}</div>
      </div>
    </div>
    <h4 class="hint-text" style="margin:0.8rem 0 0.3rem 0">By day</h4>
    <table class="usage-table">
      <thead><tr><th>Day</th><th>Reqs</th><th>Cost</th></tr></thead>
      <tbody>
        ${(data.byDay || []).map(d => `<tr><td>${d.day}</td><td>${d.requests}</td><td>$${d.cost.toFixed(4)}</td></tr>`).join('')}
      </tbody>
    </table>
    <h4 class="hint-text" style="margin:0.8rem 0 0.3rem 0">By model</h4>
    <table class="usage-table">
      <thead><tr><th>Model</th><th>Reqs</th><th>Cost</th></tr></thead>
      <tbody>
        ${Object.entries(data.byModel || {}).map(([m, v]) => `<tr><td>${escapeHtml(m)}</td><td>${v.requests}</td><td>$${v.cost.toFixed(4)}</td></tr>`).join('')}
      </tbody>
    </table>
    <h4 class="hint-text" style="margin:0.8rem 0 0.3rem 0">By mode</h4>
    <table class="usage-table">
      <thead><tr><th>Mode</th><th>Reqs</th><th>Cost</th></tr></thead>
      <tbody>
        ${Object.entries(data.byMode || {}).map(([m, v]) => `<tr><td>${escapeHtml(m)}</td><td>${v.requests}</td><td>$${v.cost.toFixed(4)}</td></tr>`).join('')}
      </tbody>
    </table>
  `;
}
$('#btnRefreshUsage')?.addEventListener('click', loadUsage);
$('#usageRange')?.addEventListener('change', loadUsage);

// Update top-right pill from /api/usage today total
async function refreshTodayPill() {
  try {
    const res = await fetch('/Interview/api/usage?days=1');
    const data = await res.json();
    state.todayCost = data.total?.cost || 0;
    updateUsagePill();
  } catch {}
}
usagePill?.addEventListener('click', () => { menuDrawer.classList.remove('hidden'); switchTab('usage'); });

// =============================================================================
// Prep mode
// =============================================================================
$('#btnRunPrep')?.addEventListener('click', async () => {
  const out = $('#prepOutput');
  out.innerHTML = '<em>Generating prep brief…</em>';
  try {
    const res = await fetch('/Interview/api/prep', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: $('#prepModel').value,
        jobDescription: $('#prepJd').value,
        enabledDocIds: state.enabledDocIds.size > 0 ? [...state.enabledDocIds] : undefined,
      }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of evt.split('\n').filter(l => l.startsWith('data: '))) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) { full += parsed.text; out.innerHTML = renderMarkdown(full); }
          } catch {}
        }
      }
    }
  } catch (e) {
    out.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(e.message)}</span>`;
  }
});

// =============================================================================
// Drawer tabs
// =============================================================================
$$('.drawer-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function switchTab(name) {
  $$('.drawer-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  refreshActiveTab();
}

function refreshActiveTab() {
  const active = $('.tab-pane.active')?.dataset.pane;
  if (active === 'docs') loadDocuments();
  else if (active === 'personas') loadPersonas();
  else if (active === 'sessions') loadSessions();
  else if (active === 'usage') loadUsage();
}

// =============================================================================
// Document Picture-in-Picture (Phase 5)
// =============================================================================
const pipSupported = 'documentPictureInPicture' in window;
if (pipSupported) btnPip.style.display = 'flex';

btnPip.addEventListener('click', togglePip);

async function togglePip() {
  if (state.pipWindow) { state.pipWindow.close(); state.pipWindow = null; return; }
  if (!pipSupported) { alert('Document Picture-in-Picture not supported in this browser.'); return; }
  try {
    state.pipWindow = await documentPictureInPicture.requestWindow({ width: 420, height: 600 });
    state.pipWindow.document.head.innerHTML = `<title>Interview answers</title>` +
      `<link rel="stylesheet" href="${location.origin}/Interview/styles.css">`;
    state.pipWindow.document.body.innerHTML = `<div id="pipRoot" class="pip-root"><div class="pip-header"><strong>Latest answer</strong></div><div id="pipBody"></div></div>`;
    state.pipWindow.addEventListener('pagehide', () => { state.pipWindow = null; });
    renderPip();
  } catch (e) {
    console.error('PiP request failed', e);
    alert('Could not open Picture-in-Picture: ' + e.message);
  }
}

function renderPip() {
  if (!state.pipWindow) return;
  const body = state.pipWindow.document.getElementById('pipBody');
  if (!body) return;
  if (!state.lastAnswerCard) {
    body.innerHTML = '<em>No answer yet</em>';
    return;
  }
  const ansHtml = state.lastAnswerCard.querySelector('.answer-text').innerHTML;
  const q = state.lastAnswerCard.querySelector('.question').textContent;
  body.innerHTML = `<div class="pip-question">${escapeHtml(q)}</div><div class="answer-text">${ansHtml}</div>`;
}

// =============================================================================
// Hotkeys
// =============================================================================
document.addEventListener('keydown', (e) => {
  // Ignore when focus is in an input/textarea/select
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Escape') {
    if (!menuDrawer.classList.contains('hidden')) menuDrawer.classList.add('hidden');
    if (!recapModal.classList.contains('hidden')) recapModal.classList.add('hidden');
    if (!helpModal.classList.contains('hidden')) helpModal.classList.add('hidden');
    if (!speakerModal.classList.contains('hidden')) speakerModal.classList.add('hidden');
    return;
  }

  if (e.key === '?') { helpModal.classList.remove('hidden'); e.preventDefault(); return; }
  if (e.key === 'm' || e.key === 'M') { menuDrawer.classList.toggle('hidden'); if (!menuDrawer.classList.contains('hidden')) refreshActiveTab(); e.preventDefault(); return; }
  if (e.key === 'p' || e.key === 'P') { togglePip(); e.preventDefault(); return; }
  if (e.key === 'c' || e.key === 'C') { btnClearAnswers.click(); e.preventDefault(); return; }
  if (e.key === 'y' || e.key === 'Y') { copyToClipboard(state.lastAnswerText); e.preventDefault(); return; }

  // Mode chips 1-6
  if (/^[1-6]$/.test(e.key)) {
    const idx = parseInt(e.key) - 1;
    const chips = $$('#modeChips .mode-btn');
    if (chips[idx]) { setMode(chips[idx].dataset.mode); e.preventDefault(); }
    return;
  }

  if (e.key === ' ') {
    if (state.lastAnsweredQuestion) {
      generateAnswer(state.lastAnsweredQuestion);
      e.preventDefault();
    }
    return;
  }

  if (e.key === 'r') { if (state.lastAnsweredQuestion) generateAnswer(state.lastAnsweredQuestion, { refinement: 'shorter' }); e.preventDefault(); return; }
  if (e.key === 'R') { if (state.lastAnsweredQuestion) generateAnswer(state.lastAnsweredQuestion, { refinement: 'longer' }); e.preventDefault(); return; }
  if (e.key === 'e') { if (state.lastAnsweredQuestion) generateAnswer(state.lastAnsweredQuestion, { refinement: 'example' }); e.preventDefault(); return; }
  if (e.key === 's') { if (state.lastAnsweredQuestion) generateAnswer(state.lastAnsweredQuestion, { refinement: 'simpler' }); e.preventDefault(); return; }
});

$('#btnCloseHelp').addEventListener('click', () => helpModal.classList.add('hidden'));

// =============================================================================
// Clear answers
// =============================================================================
btnClearAnswers.addEventListener('click', () => {
  answersEl.innerHTML = '<div class="empty-state"><p>Answers will appear here when questions are detected</p></div>';
  state.lastAnswerCard = null;
});

// =============================================================================
// Theme (auto, follows system)
// =============================================================================
function getTheme() { return localStorage.getItem('interview-theme') || 'auto'; }
function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
applyTheme(getTheme());

// =============================================================================
// Init
// =============================================================================
async function init() {
  loadDocuments();
  loadPersonas();
  refreshTodayPill();
  // Load speaker prefs
  try {
    const res = await fetch('/Interview/api/speaker-prefs');
    const p = await res.json();
    state.speakerStrategy = p.strategy || 'manual';
    if (state.speakerStrategy === 'second_speaker') autoPickSpeaker.checked = true;
  } catch {}
}
init();
