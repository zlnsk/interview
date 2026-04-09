// --- State ---
const state = {
  ws: null,
  mediaStream: null,
  audioContext: null,
  processor: null,
  isCapturing: false,
  mySpeaker: null, // speaker ID that is "me"
  speakers: new Map(), // speaker_id -> { lastText }
  utterances: [], // { speaker, text, isFinal, timestamp }
  documents: [],
  pendingQuestion: null,
  questionDebounce: null,
  lastAnsweredQuestion: null,
  speakerModalShown: false
};

// --- DOM ---
const $ = (sel) => document.querySelector(sel);
const btnCapture = $('#btnCapture');
const btnStop = $('#btnStop');
const btnUpload = $('#btnUpload');
const btnCloseDrawer = $('#btnCloseDrawer');
const btnClearAnswers = $('#btnClearAnswers');
const statusPill = $('#statusPill');
const transcriptEl = $('#transcript');
const answersEl = $('#answers');
const docsDrawer = $('#docsDrawer');
const docsList = $('#docsList');
const uploadForm = $('#uploadForm');
const fileInput = $('#fileInput');
const modelSelect = $('#modelSelect');
const speakerModal = $('#speakerModal');
const speakerOptions = $('#speakerOptions');
const btnSkipSpeaker = $('#btnSkipSpeaker');
const speakerLegend = $('#speakerLegend');

// --- Utility ---
function setStatus(text, type = '') {
  statusPill.className = 'status-pill ' + type;
  statusPill.querySelector('.label').textContent = text;
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// --- Audio Capture ---
btnCapture.addEventListener('click', startCapture);
btnStop.addEventListener('click', stopCapture);

async function startCapture() {
  try {
    // Request tab audio sharing
    state.mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Chrome requires video for getDisplayMedia, we ignore it
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    // Check if we actually got audio
    const audioTracks = state.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      alert('No audio track shared. Make sure to check "Share tab audio" in the dialog.');
      state.mediaStream.getTracks().forEach(t => t.stop());
      return;
    }

    // Show PiP of the shared tab
    const videoTracks = state.mediaStream.getVideoTracks();
    if (videoTracks.length > 0) {
      const pipVideo = document.getElementById('pipVideo');
      pipVideo.srcObject = new MediaStream(videoTracks);
      pipVideo.play().then(() => {
        pipVideo.requestPictureInPicture().catch(() => {
          // PiP not supported or denied — show inline instead
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

    // Set up audio processing — tab audio only
    state.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = state.audioContext.createMediaStreamSource(
      new MediaStream(audioTracks)
    );

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

    // Connect WebSocket
    connectWS();

    state.isCapturing = true;
    btnCapture.style.display = 'none';
    btnStop.style.display = 'flex';
    setStatus('Connecting...', '');
    transcriptEl.innerHTML = '';

    // Handle stream end (user stops sharing)
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

  // Close PiP
  const pipVideo = document.getElementById('pipVideo');
  if (document.pictureInPictureElement === pipVideo) {
    document.exitPictureInPicture().catch(() => {});
  }
  pipVideo.srcObject = null;
  document.getElementById('pipContainer').classList.add('hidden');

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }

  if (state.processor) {
    state.processor.disconnect();
    state.processor = null;
  }

  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }

  if (state.ws) {
    state.ws.send(JSON.stringify({ type: 'stop' }));
    state.ws.close();
    state.ws = null;
  }

  btnCapture.style.display = 'flex';
  btnStop.style.display = 'none';
  setStatus('Stopped', '');
}

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/Interview/ws`);

  state.ws.onopen = () => {
    state.ws.send(JSON.stringify({
      type: 'start',
      sampleRate: 16000
    }));
  };

  state.ws.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    handleDeepgramMessage(data);
  };

  state.ws.onclose = () => {
    if (state.isCapturing) {
      setStatus('Reconnecting...', 'error');
      setTimeout(connectWS, 2000);
    }
  };

  state.ws.onerror = () => {
    setStatus('Connection error', 'error');
  };
}

// --- Deepgram Message Handling ---
let currentUtteranceEl = null;

function handleDeepgramMessage(data) {
  if (data.type === 'status') {
    if (data.status === 'connected') {
      setStatus('Listening', 'active');
    } else if (data.status === 'disconnected') {
      setStatus('Disconnected', 'error');
    }
    return;
  }

  if (data.type === 'error') {
    setStatus('Error: ' + data.error, 'error');
    return;
  }

  // Transcript result
  if (data.type === 'Results' && data.channel) {
    const alt = data.channel.alternatives[0];
    if (!alt || !alt.transcript) return;

    const transcript = alt.transcript.trim();
    if (!transcript) return;

    const isFinal = data.is_final;
    const speaker = alt.words?.[0]?.speaker ?? -1;

    // Track speakers
    if (speaker >= 0 && !state.speakers.has(speaker)) {
      state.speakers.set(speaker, { lastText: transcript });
      updateSpeakerLegend();

      // If we have 2+ speakers and haven't shown the modal, show it
      if (state.speakers.size >= 2 && !state.speakerModalShown) {
        state.speakerModalShown = true;
        setTimeout(showSpeakerModal, 1000);
      }
    }

    if (isFinal) {
      // Remove interim if exists
      if (currentUtteranceEl) {
        currentUtteranceEl.remove();
        currentUtteranceEl = null;
      }

      // Group consecutive same-speaker utterances
      const lastUtt = state.utterances[state.utterances.length - 1];
      if (lastUtt && lastUtt.speaker === speaker && (Date.now() - lastUtt.timestamp) < 8000) {
        // Append to the last utterance
        lastUtt.text += ' ' + transcript;
        lastUtt.timestamp = Date.now();
        const lastEl = transcriptEl.querySelector('.utterance:last-child');
        if (lastEl) {
          lastEl.querySelector('.text').textContent = lastUtt.text;
        }
      } else {
        addUtterance(speaker, transcript, true);
      }
      scrollToBottom(transcriptEl);

      // Detect questions from non-me speakers
      if (speaker !== state.mySpeaker && isQuestion(transcript)) {
        scheduleAnswer(transcript);
      } else if (speaker !== state.mySpeaker && state.pendingQuestion && state.questionDebounce) {
        // Speaker is still talking after question — append to pending question
        state.pendingQuestion += ' ' + transcript;
      }
    } else {
      // Interim result — update in place
      if (!currentUtteranceEl) {
        currentUtteranceEl = createUtteranceEl(speaker, transcript, false);
        transcriptEl.appendChild(currentUtteranceEl);
      } else {
        currentUtteranceEl.querySelector('.text').textContent = transcript;
      }
      scrollToBottom(transcriptEl);
    }
  }

  // Utterance end event
  if (data.type === 'UtteranceEnd') {
    currentUtteranceEl = null;
  }
}

function addUtterance(speaker, text, isFinal) {
  state.utterances.push({ speaker, text, isFinal, timestamp: Date.now() });

  const el = createUtteranceEl(speaker, text, isFinal);
  transcriptEl.appendChild(el);
  scrollToBottom(transcriptEl);

  // Remove empty state
  const empty = transcriptEl.querySelector('.empty-state');
  if (empty) empty.remove();
}

function createUtteranceEl(speaker, text, isFinal) {
  const el = document.createElement('div');
  const speakerClass = speaker >= 0 ? `speaker-${speaker % 4}` : '';
  const isMe = speaker === state.mySpeaker;
  el.className = `utterance ${speakerClass} ${isFinal ? '' : 'interim'} ${isMe ? 'is-me' : ''}`;

  const label = isMe ? 'You' : `Speaker ${speaker + 1}`;
  const badge = isMe ? '<span class="badge you">YOU</span>' : '';

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

// --- Question Detection ---
function isQuestion(text) {
  const lower = text.toLowerCase().trim();
  // Ends with question mark
  if (lower.endsWith('?')) return true;
  // Starts with question words
  const qWords = ['what', 'why', 'how', 'when', 'where', 'who', 'which', 'can you', 'could you', 'tell me', 'describe', 'explain', 'walk me through', 'give me', 'do you', 'have you', 'are you', 'is there', 'would you'];
  return qWords.some(w => lower.startsWith(w));
}

function scheduleAnswer(question) {
  // Don't answer within 8 seconds of the last answer
  if (state.lastAnswerTime && (Date.now() - state.lastAnswerTime) < 3000) return;

  // Deduplicate: skip if too similar to last answered question
  if (state.lastAnsweredQuestion) {
    const prev = state.lastAnsweredQuestion.toLowerCase();
    const curr = question.toLowerCase();
    if (curr === prev || prev.includes(curr) || curr.includes(prev)) return;
    // Word overlap check — if >50% words match, skip
    const prevWords = new Set(prev.split(/\s+/));
    const currWords = curr.split(/\s+/);
    const overlap = currWords.filter(w => prevWords.has(w)).length;
    if (overlap > currWords.length * 0.5) return;
  }

  // Debounce — wait for speaker to finish (2.5s of silence after last question fragment)
  clearTimeout(state.questionDebounce);
  state.pendingQuestion = question;
  state.questionDebounce = setTimeout(() => {
    state.lastAnsweredQuestion = state.pendingQuestion;
    state.lastAnswerTime = Date.now();
    generateAnswer(state.pendingQuestion);
  }, 2500);
}

// --- AI Answer Generation ---
async function generateAnswer(question) {
  // Build recent transcript context (last 20 utterances)
  const recentTranscript = state.utterances
    .slice(-20)
    .map(u => {
      const label = u.speaker === state.mySpeaker ? 'Me' : `Speaker ${u.speaker + 1}`;
      return `${label}: ${u.text}`;
    })
    .join('\n');

  const model = modelSelect.value;

  // Create answer card
  const card = document.createElement('div');
  card.className = 'answer-card';
  card.innerHTML = `
    <div class="question">${escapeHtml(question)}</div>
    <div class="answer-text"><span class="cursor"></span></div>
    <div class="meta">
      <span>${model === 'opus' ? 'Opus 4.6' : 'Sonnet 4.6'}</span>
      <span>${new Date().toLocaleTimeString()}</span>
    </div>
  `;

  // Remove empty state
  const empty = answersEl.querySelector('.empty-state');
  if (empty) empty.remove();

  answersEl.insertBefore(card, answersEl.firstChild);
  const textEl = card.querySelector('.answer-text');

  try {
    const res = await fetch('/Interview/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, transcript: recentTranscript, model })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data);
          if (parsed.text) {
            fullText += parsed.text;
            textEl.innerHTML = renderMarkdown(fullText) + '<span class="cursor"></span>';
          }
          if (parsed.error) {
            textEl.innerHTML = `<span style="color:var(--danger)">Error: ${escapeHtml(parsed.error)}</span>`;
          }
        } catch (e) {}
      }
    }

    // Final render with full markdown
    textEl.innerHTML = renderMarkdown(fullText);

  } catch (err) {
    textEl.innerHTML = `<span style="color:var(--danger)">Failed: ${escapeHtml(err.message)}</span>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
const esc = escapeHtml;

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    return marked.parse(text, { breaks: true });
  }
  // Fallback: basic formatting if marked.js fails to load
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// --- Speaker Selection ---
function showSpeakerModal() {
  speakerOptions.innerHTML = '';
  for (const [id, info] of state.speakers) {
    const btn = document.createElement('button');
    btn.textContent = `Speaker ${id + 1} — "${info.lastText?.slice(0, 60) || '...'}"`;
    btn.onclick = () => {
      state.mySpeaker = id;
      speakerModal.classList.add('hidden');
      updateSpeakerLegend();
      // Re-render transcript with "You" labels
      reRenderTranscript();
    };
    speakerOptions.appendChild(btn);
  }
  speakerModal.classList.remove('hidden');
}

btnSkipSpeaker.addEventListener('click', () => {
  speakerModal.classList.add('hidden');
});

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

// --- Documents ---
btnUpload.addEventListener('click', () => {
  docsDrawer.classList.toggle('hidden');
  if (!docsDrawer.classList.contains('hidden')) {
    loadDocuments();
  }
});

btnCloseDrawer.addEventListener('click', () => {
  docsDrawer.classList.add('hidden');
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!fileInput.files[0]) return;

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('type', $('#docType').value);

  try {
    const res = await fetch('/Interview/api/upload', {
      method: 'POST',
      body: formData
    });
    const doc = await res.json();
    if (doc.error) {
      alert(doc.error);
    } else {
      fileInput.value = '';
      loadDocuments();
    }
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
});

async function loadDocuments() {
  try {
    const res = await fetch('/Interview/api/documents');
    const docs = await res.json();
    state.documents = docs;
    renderDocsList();
  } catch (err) {
    console.error('Failed to load docs:', err);
  }
}

function renderDocsList() {
  if (state.documents.length === 0) {
    docsList.innerHTML = '<p style="color:var(--text2);font-size:0.85rem">No documents uploaded yet</p>';
    return;
  }

  docsList.innerHTML = state.documents.map(doc => `
    <div class="doc-item">
      <div class="doc-info">
        <span class="doc-name">${escapeHtml(doc.name)}</span>
        <span class="doc-type">${escapeHtml(doc.type.replace('_', ' '))}</span>
      </div>
      <button class="btn-delete" onclick="deleteDoc('${doc.id}')">Remove</button>
    </div>
  `).join('');
}

window.deleteDoc = async function(id) {
  try {
    await fetch(`/Interview/api/documents/${id}`, { method: 'DELETE' });
    loadDocuments();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
};

// --- Clear Answers ---
btnClearAnswers.addEventListener('click', () => {
  answersEl.innerHTML = '<div class="empty-state"><p>Answers will appear here when questions are detected</p></div>';
});

// --- Theme Toggle ---
function getTheme() {
  return localStorage.getItem('interview-theme') || 'auto';
}

function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  updateThemeIcon();
}

function updateThemeIcon() {
  const btn = document.getElementById('btnTheme');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  btn.textContent = isDark ? '\u2600' : '\u263E';
  btn.title = isDark ? 'Switch to light' : 'Switch to dark';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = current === 'dark' || (!current && systemDark);
  const next = isDark ? 'light' : 'dark';
  localStorage.setItem('interview-theme', next);
  applyTheme(next);
}

applyTheme(getTheme());
document.getElementById('btnTheme')?.addEventListener('click', toggleTheme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'auto') updateThemeIcon();
});

// --- Init ---
loadDocuments();
