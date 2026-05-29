// voice-studio.js
// Voice ingestion studio for MyAITwin — the whole Voice surface.
//
// Capture-first: a voice-reactive Web Audio visualisation is the centerpiece,
// a live transcript streams beneath it, and one record control runs the whole
// flow. On stop the recorded audio is sent to /api/twin/voice-note, where
// Whisper transcribes it server-side and the existing ingestion pipeline stores
// it (auto-title, auto-tag, provenance, multi-tenant safe via requireTenant).
//
// LIVE TRANSCRIPT — Deepgram primary, Web Speech fallback:
//   1) Primary: the server-side Deepgram stream (Nova-3) via an ephemeral token
//      from /api/voice/token. Needs DEEPGRAM_API_KEY set in production.
//   2) Fallback: the browser's Web Speech API (SpeechRecognition). Used only as
//      resilience when Deepgram is unavailable (no key / token 503 / WS error),
//      so the live transcript degrades rather than dies.
//   3) If neither live path is available, the studio shows an honest one-line
//      note (never a silent dead screen) and the capture still records.
// Storage transcription is ALWAYS Whisper (server-side, on stop) regardless of
// which live path ran. Deepgram/Web Speech only drive the live display.
//
// Usage:
//   const studio = new VoiceStudio({ mountIn, apiHeaders, onStored });
//   studio.mount();
//   // later: studio.cancel(); studio.destroy();

const TOKEN_URL       = '/api/voice/token';
const STORE_URL       = '/api/twin/voice-note';
const MAX_RECORD_MS   = 10 * 60 * 1000;   // 10-minute hard cap
const DG_CLOSE_WAIT   = 1500;             // ms to wait for Deepgram's final words
const N_BARS          = 72;               // radial bars in the visualisation

// Mic-trouble copy (section 5): calm and specific, never a dead silent screen.
// Both point at the site permission (address-bar icon), system sound settings,
// and Safari as the reliable fallback when a managed Chrome profile blocks the
// mic (the exact wall a real user hit). No em dashes.
const MIC_BLOCKED_MSG = "Can't reach your microphone. Check this site's mic permission using the icon in the address bar, then your system sound settings. If Chrome keeps blocking it, Safari usually works.";
const MIC_SILENT_MSG  = "Your microphone is on but no sound is coming through. Check that the right mic is selected and that your system sound settings allow it. If Chrome keeps blocking the mic, Safari usually works.";

// ── One-time style injection ─────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('vs-styles')) return;
  const s = document.createElement('style');
  s.id = 'vs-styles';
  s.textContent = `
    .vs {
      height: 100%;
      width: 100%;
      max-width: 640px;
      margin: 0 auto;
      padding: 20px 24px 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }

    /* ── State line ───────────────────────────────────────────────────────── */
    .vs-status {
      display: flex; align-items: center; gap: 9px;
      min-height: 18px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.16em;
      color: var(--muted);
    }
    .vs-state-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--muted);
      border: 1px solid var(--ink);
      flex-shrink: 0;
      transition: background 200ms;
    }
    .vs[data-state="listening"] .vs-state-dot {
      background: var(--coral);
      animation: vs-blink 1s steps(1) infinite;
    }
    .vs[data-state="saving"] .vs-state-dot { background: var(--yellow-deep); }
    .vs[data-state="saved"]   .vs-state-dot { background: var(--ink); }
    @keyframes vs-blink { 50% { opacity: 0.2; } }
    .vs-timer {
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.08em; color: var(--ink-2);
    }

    /* ── Visualisation stage ──────────────────────────────────────────────── */
    .vs-stage {
      flex: 1;
      width: 100%;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .vs-canvas {
      width: 100%;
      height: 100%;
      max-width: 340px;
      max-height: 340px;
      display: block;
    }

    /* ── Live transcript ──────────────────────────────────────────────────── */
    .vs-transcript {
      width: 100%;
      max-height: 132px;
      min-height: 0;
      overflow-y: auto;
      text-align: center;
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 16px; line-height: 1.6;
      color: var(--ink);
      word-break: break-word;
    }
    .vs-transcript:empty { display: none; }
    .vs-interim { color: var(--muted); }

    /* ── Live-transcript status note (honest, never a silent dead screen) ─── */
    .vs-live-note {
      width: 100%;
      text-align: center;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--muted);
    }
    .vs-live-note[hidden] { display: none; }

    /* ── Result (captured) card ───────────────────────────────────────────── */
    .vs-result {
      width: 100%;
      background: var(--card);
      border: 1.5px solid var(--ink);
      border-radius: 12px;
      box-shadow: var(--shadow-brutal, 2px 2px 0 #0F0E0D);
      padding: 14px 16px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .vs-result-ack {
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 15px; line-height: 1.55; color: var(--ink);
    }
    .vs-result-meta {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted);
    }
    .vs-result-count {
      background: var(--coral); color: #fff;
      border: 1.5px solid var(--ink);
      border-radius: 999px; padding: 2px 9px;
    }
    .vs-result-link {
      color: var(--ink-2); text-decoration: none;
      border-bottom: 1px solid var(--line);
      text-transform: none; letter-spacing: 0.02em;
    }
    .vs-result-link:hover { color: var(--ink); border-bottom-color: var(--ink); }
    .vs-error {
      width: 100%;
      color: #c0392b;
      font-family: 'Source Serif 4', Georgia, serif;
      font-size: 14px; line-height: 1.55; text-align: center;
    }

    /* ── Record control ───────────────────────────────────────────────────── */
    .vs-controls {
      display: flex; flex-direction: column; align-items: center; gap: 10px;
      flex-shrink: 0;
    }
    .vs-record {
      position: relative;
      width: 74px; height: 74px;
      border-radius: 50%;
      background: var(--coral);
      border: 1.5px solid var(--ink);
      box-shadow: 3px 3px 0 var(--ink);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 100ms, box-shadow 100ms, background 160ms;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      user-select: none; -webkit-user-select: none;
    }
    .vs-record:hover:not(:disabled) { transform: translate(1px, 1px); box-shadow: 2px 2px 0 var(--ink); }
    .vs-record:active:not(:disabled) { transform: translate(3px, 3px); box-shadow: none; }
    .vs-record:disabled { cursor: default; opacity: 0.55; }
    .vs[data-state="listening"] .vs-record { background: var(--ink); }
    /* Pulse ring while listening */
    .vs[data-state="listening"] .vs-record::after {
      content: ''; position: absolute; inset: -6px;
      border-radius: 50%;
      border: 1.5px solid var(--coral);
      animation: vs-ring 1.4s ease-out infinite;
    }
    @keyframes vs-ring {
      0%   { transform: scale(0.92); opacity: 0.7; }
      100% { transform: scale(1.18); opacity: 0; }
    }
    .vs-record-glyph { width: 22px; height: 22px; color: #fff; display: block; }
    .vs-record-stop {
      width: 20px; height: 20px; border-radius: 4px;
      background: #fff; display: none;
    }
    .vs[data-state="listening"] .vs-record-glyph { display: none; }
    .vs[data-state="listening"] .vs-record-stop  { display: block; }

    .vs-hint {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.12em;
      color: var(--muted);
      min-height: 13px;
    }
    .vs-saving-dots {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px; letter-spacing: 5px; color: #fff;
      animation: vs-dots 1.2s ease-in-out infinite;
    }
    @keyframes vs-dots { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

    @media (max-width: 640px) {
      .vs { padding: 12px 16px 22px; }
      .vs-canvas { max-width: 260px; max-height: 260px; }
      .vs-record { width: 66px; height: 66px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .vs[data-state="listening"] .vs-record::after,
      .vs[data-state="listening"] .vs-state-dot { animation: none; }
    }
  `;
  document.head.appendChild(s);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class VoiceStudio {
  /**
   * @param {object} opts
   * @param {Element}  opts.mountIn      — container to render the studio into
   * @param {object}  [opts.apiHeaders]  — extra headers (e.g. X-Anon-Token)
   * @param {Function}[opts.onStored]    — (result) callback after a successful save
   */
  constructor({ mountIn, apiHeaders = {}, onStored } = {}) {
    this._mount    = mountIn;
    this._headers  = { 'Content-Type': 'application/json', ...apiHeaders };
    this._onStored = onStored || (() => {});

    this._state    = 'idle';     // idle | listening | saving | saved | error
    this._root     = null;
    this._canvas   = null;
    this._ctx2d    = null;

    // Audio graph
    this._stream      = null;
    this._audioCtx    = null;
    this._analyser    = null;
    this._source      = null;
    this._timeData    = null;
    this._freqData    = null;
    this._recorder    = null;
    this._mimeType    = 'audio/webm';
    this._chunks      = [];
    this._sawSignal   = false;  // analyser detected real audio energy this session
    this._vizSampled  = false;  // analyser actually produced data (Web Audio worked)

    // Live transcript (Hybrid: Web Speech primary, Deepgram fallback)
    this._liveMode      = null;   // 'webspeech' | 'deepgram' | null
    this._speech        = null;   // SpeechRecognition instance
    this._speechFatal   = false;  // stop auto-restarting after a fatal error
    this._ws            = null;   // Deepgram WebSocket
    this._dgActive      = false;
    this._dgFailed      = false;
    this._pendingChunks = [];
    this._transcript    = '';
    this._interim       = '';

    // Timing + animation
    this._startedAt     = null;
    this._timerId       = null;
    this._capId         = null;
    this._rafId         = null;
    this._bars          = new Float32Array(N_BARS);
    this._coreScale     = 1;
    this._amp           = 0;
    this._rotation      = 0;
    this._destroyed     = false;
  }

  // ── Mount + idle ───────────────────────────────────────────────────────────
  mount() {
    if (this._root) return;
    injectStyles();

    const root = document.createElement('div');
    root.className = 'vs';
    root.dataset.state = 'idle';
    root.innerHTML = `
      <div class="vs-status">
        <span class="vs-state-dot"></span>
        <span class="vs-state-label">Ready</span>
        <span class="vs-timer" hidden>0:00</span>
      </div>
      <div class="vs-stage"><canvas class="vs-canvas"></canvas></div>
      <div class="vs-transcript" aria-live="polite"></div>
      <div class="vs-live-note" aria-live="polite" hidden></div>
      <div class="vs-controls">
        <button type="button" class="vs-record" aria-label="Start recording">
          <svg class="vs-record-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          <span class="vs-record-stop" aria-hidden="true"></span>
        </button>
        <div class="vs-hint">Think out loud</div>
      </div>
    `;
    this._mount.appendChild(root);
    this._root   = root;
    this._canvas = root.querySelector('.vs-canvas');
    this._ctx2d  = this._canvas.getContext('2d');

    this._recordBtn = root.querySelector('.vs-record');
    this._recordBtn.addEventListener('click', () => this._onRecordClick());

    // Keep the canvas crisp; redraw sizing on container changes.
    this._ro = new ResizeObserver(() => this._resizeCanvas());
    this._ro.observe(root.querySelector('.vs-stage'));
    this._resizeCanvas();

    this._startLoop();
  }

  // ── Record button ───────────────────────────────────────────────────────────
  _onRecordClick() {
    if (this._state === 'idle' || this._state === 'saved' || this._state === 'error') {
      this._start();
    } else if (this._state === 'listening') {
      this._stopAndStore();
    }
  }

  // ── Start capture ────────────────────────────────────────────────────────────
  async _start() {
    // Reset transcript + any previous result
    this._transcript = '';
    this._interim    = '';
    this._chunks     = [];
    this._dgActive   = false;
    this._dgFailed   = false;
    this._speechFatal = false;
    this._liveMode   = null;
    this._pendingChunks = [];
    this._sawSignal  = false;
    this._vizSampled = false;
    this._clearResult();
    this._setLiveNote('');
    this._renderTranscript();

    const stream = await this._requestMic();
    if (!stream) return;

    // A granted stream with no live audio track means the OS/browser handed us
    // a dead mic. Say so plainly rather than recording silence.
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      this._showError(MIC_SILENT_MSG);
      return;
    }
    this._stream = stream;

    this._setState('listening');
    this._setHint('Tap to finish');

    // Web Audio analyser for the visualisation. Awaited so the AudioContext is
    // resumed (it can start suspended after the getUserMedia await) before the
    // draw loop reads it — otherwise the shape stays flat.
    await this._initAnalyser(stream);

    // MediaRecorder builds the blob for Whisper (storage) and, when Deepgram is
    // the live path, feeds it the audio chunks.
    this._startRecorder(stream);

    // Live transcript — Hybrid: Web Speech first, Deepgram fallback, honest note.
    this._startLiveTranscript();

    // Timer + hard cap
    this._startedAt = Date.now();
    this._tickTimer();
    this._timerId = setInterval(() => this._tickTimer(), 500);
    this._capId   = setTimeout(() => { if (this._state === 'listening') this._stopAndStore(); }, MAX_RECORD_MS);
  }

  async _requestMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this._showError('This browser cannot record audio. Try Safari, or capture on your phone.');
      return null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      console.warn('[voice-studio] getUserMedia failed:', err?.name, err?.message);
      this._showError(MIC_BLOCKED_MSG);
      return null;
    }
  }

  async _initAnalyser(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { console.warn('[voice-studio] Web Audio API unavailable'); this._analyser = null; return; }
      this._audioCtx = new AC();
      // The context can start 'suspended' because we created it after awaiting
      // getUserMedia (outside the synchronous click gesture). Resume it and
      // WAIT — a suspended context returns all-zero analyser data, which is why
      // the shape never reacted to the voice.
      if (this._audioCtx.state === 'suspended') {
        try { await this._audioCtx.resume(); }
        catch (e) { console.warn('[voice-studio] audioCtx resume failed:', e.message); }
      }
      const src = this._audioCtx.createMediaStreamSource(stream);
      const analyser = this._audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.78;
      src.connect(analyser);
      this._source   = src;
      this._analyser = analyser;
      this._timeData = new Uint8Array(analyser.fftSize);
      this._freqData = new Uint8Array(analyser.frequencyBinCount);
    } catch (e) {
      console.warn('[voice-studio] analyser init failed:', e.message);
      this._analyser = null; // viz falls back to idle motion
    }
  }

  _startRecorder(stream) {
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mime = preferred.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'audio/webm';
    this._mimeType = mime;

    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime }); }
    catch { rec = new MediaRecorder(stream); this._mimeType = 'audio/webm'; }

    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      this._chunks.push(e.data);            // always: the blob for Whisper storage
      // Deepgram-only: stream chunks to the WS (buffer until it opens). Web Speech
      // captures its own audio, so we never buffer chunks for it.
      if (this._liveMode === 'webspeech') return;
      if (this._ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => { if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(buf); });
      } else if (this._liveMode !== null) {
        this._pendingChunks.push(e.data);
      }
    };
    rec.start(250);
    this._recorder = rec;
  }

  // ── Live transcript dispatcher ───────────────────────────────────────────────
  // Deepgram is the primary engine. Mark its intent synchronously so the
  // recorder buffers early chunks (incl. the WebM header) while the token fetch
  // and WS handshake complete. If Deepgram cannot start (no key / token 503 /
  // WS error), _connectDeepgram falls back to Web Speech as resilience.
  _startLiveTranscript() {
    this._liveMode = 'deepgram';
    this._connectDeepgram();
  }

  // Deepgram could not start — try the browser's recognizer as a fallback.
  // Web Speech captures its own audio, so the recorder stops buffering for the
  // (now dead) Deepgram socket once _liveMode flips to 'webspeech'.
  _fallbackToWebSpeech() {
    if (this._state !== 'listening') return;       // capture already finished
    if (this._liveMode === 'webspeech') return;    // fallback already running
    if (this._startWebSpeech()) {                  // sets _liveMode = 'webspeech'
      this._setLiveNote('');
      return;
    }
    // No live engine at all. The capture still records and saves on stop.
    this._setLiveNote('Live transcript is off in this browser. Your words are still saved when you finish.');
  }

  // ── Web Speech API live transcript (fallback path) ───────────────────────────
  _startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    try {
      const rec = new SR();
      rec.continuous     = true;
      rec.interimResults = true;
      rec.lang = (navigator.language && /^en/i.test(navigator.language)) ? navigator.language : 'en-US';

      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r   = e.results[i];
          const txt = (r[0] && r[0].transcript) ? r[0].transcript : '';
          if (r.isFinal) {
            const clean = txt.trim();
            if (clean) this._transcript += (this._transcript ? ' ' : '') + clean;
          } else {
            interim += txt;
          }
        }
        this._interim = interim;
        this._setLiveNote('');
        this._renderTranscript();
      };

      rec.onerror = (e) => {
        const err = e.error;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this._speechFatal = true;
          this._setLiveNote('Live transcript was blocked. Your words are still saved when you finish.');
        } else if (err === 'network') {
          this._setLiveNote('Live transcript needs a connection. Your words are still saved.');
        } else if (err === 'audio-capture') {
          this._speechFatal = true;
          this._setLiveNote('Live transcript could not reach the mic. Your words are still saved.');
        }
        // 'no-speech' / 'aborted' are benign — onend will restart.
      };

      rec.onend = () => {
        // Web Speech auto-stops on pauses; keep it alive while still listening.
        if (this._state === 'listening' && !this._speechFatal) {
          try { rec.start(); } catch { /* already started or stopping */ }
        }
      };

      rec.start();
      this._speech   = rec;
      this._liveMode = 'webspeech';
      return true;
    } catch (e) {
      console.warn('[voice-studio] Web Speech init failed:', e.message);
      return false;
    }
  }

  // ── Deepgram live transcript (server-side stream, ephemeral token) ───────────
  // Primary engine. On any failure (no key / token 503 / WS error) it calls
  // _fallbackToWebSpeech() so the live transcript degrades rather than dies.
  async _connectDeepgram() {
    let key;
    try {
      const resp = await fetch(TOKEN_URL, { method: 'POST', headers: this._headers, body: '{}' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.key) throw new Error('no key');
      key = data.key;
    } catch (err) {
      console.warn('[voice-studio] Deepgram token unavailable, falling back:', err.message);
      this._dgFailed = true;
      this._fallbackToWebSpeech();
      return;
    }

    const params = new URLSearchParams({
      model: 'nova-3', language: 'en', punctuate: 'true',
      smart_format: 'true', interim_results: 'true', endpointing: '300',
    });
    try {
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', key]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this._dgActive = true;
        this._liveMode = 'deepgram';
        this._setLiveNote('');
        for (const c of this._pendingChunks) {
          c.arrayBuffer().then(buf => { if (ws.readyState === WebSocket.OPEN) ws.send(buf); });
        }
        this._pendingChunks = [];
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type !== 'Results') return;
          const text = msg.channel?.alternatives?.[0]?.transcript || '';
          if (msg.is_final) {
            if (text) { this._transcript += (this._transcript ? ' ' : '') + text; this._interim = ''; }
          } else {
            this._interim = text;
          }
          this._renderTranscript();
        } catch { /* ignore */ }
      };
      ws.onerror = () => {
        this._dgFailed = true;
        if (!this._dgActive) this._fallbackToWebSpeech();
      };
      ws.onclose = () => {
        // Only a failure if it never went active (a normal stop closes it too).
        if (!this._dgActive) {
          this._dgFailed = true;
          this._fallbackToWebSpeech();
        }
      };
      this._ws = ws;
    } catch (err) {
      console.warn('[voice-studio] Deepgram WS failed, falling back:', err.message);
      this._dgFailed = true;
      this._fallbackToWebSpeech();
    }
  }

  // Honest one-line live-transcript status — never a silent dead screen.
  _setLiveNote(msg) {
    const el = this._root?.querySelector('.vs-live-note');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = ''; el.hidden = true; }
  }

  _renderTranscript() {
    if (!this._root) return;
    const $t = this._root.querySelector('.vs-transcript');
    if (!$t) return;
    let html = this._transcript ? esc(this._transcript) : '';
    if (this._interim) html += (html ? ' ' : '') + `<span class="vs-interim">${esc(this._interim)}</span>`;
    $t.innerHTML = html;
    $t.scrollTop = $t.scrollHeight;
  }

  // ── Stop + store ─────────────────────────────────────────────────────────────
  // Prefers the live transcript already streamed from Deepgram/Web Speech
  // (instant). Falls back to uploading the audio for server-side Whisper only
  // when no live words were captured.
  async _stopAndStore() {
    if (this._state !== 'listening') return;
    this._setState('saving');
    this._setHint('');
    this._recordBtn.disabled = true;
    this._recordBtn.querySelector('.vs-record-stop').innerHTML =
      '<span class="vs-saving-dots">◦◦◦</span>';
    this._setStatusLabel('Saving');

    clearInterval(this._timerId);
    clearTimeout(this._capId);

    // Stop MediaRecorder, wait for the final chunk.
    await new Promise(resolve => {
      if (!this._recorder || this._recorder.state === 'inactive') return resolve();
      const prev = this._recorder.onstop;
      this._recorder.onstop = (...a) => { if (prev) prev(...a); resolve(); };
      try { this._recorder.stop(); } catch { resolve(); }
    });

    // Stop mic tracks + analyser.
    this._teardownAudio();

    // Give Deepgram a moment to flush any final words (live text only).
    if (this._ws?.readyState === WebSocket.OPEN) {
      await new Promise(resolve => {
        const to = setTimeout(resolve, DG_CLOSE_WAIT);
        const prev = this._ws.onclose;
        this._ws.onclose = (...a) => { if (prev) prev(...a); clearTimeout(to); resolve(); };
        try { this._ws.send(JSON.stringify({ type: 'CloseStream' })); }
        catch { clearTimeout(to); resolve(); }
      });
    }
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }

    const today = new Date().toISOString().slice(0, 10);
    const liveTranscript = this._transcript.trim();

    // Fast path: Deepgram (or Web Speech) already transcribed everything live,
    // and the user watched those words stream in. Store that text directly —
    // no audio upload, no Whisper round trip, near-instant save.
    if (liveTranscript) {
      await this._postStore({ transcript: liveTranscript, date: today });
      return;
    }

    // ── No live transcript: fall back to uploading the audio for Whisper. ──────

    // The recorder produced no audio chunks at all — a blocked or dead mic.
    if (!this._chunks.length) {
      this._showError(MIC_SILENT_MSG);
      return;
    }

    // Audio recorded, but the analyser never saw energy (and, as established
    // above, no live words came through): the mic is granted yet silent. Point
    // at settings rather than sending silence to Whisper (vaguer message).
    if (this._vizSampled && !this._sawSignal) {
      this._showError(MIC_SILENT_MSG);
      return;
    }

    // Package the audio and send it for server-side Whisper transcription.
    let b64;
    try {
      const blob = new Blob(this._chunks, { type: this._mimeType });
      b64 = await this._blobToBase64(blob);
    } catch {
      this._showError('Could not package the recording. Try again.');
      return;
    }
    if (!b64) { this._showError('Could not read the recording. Try again.'); return; }

    await this._postStore({ audio_base64: b64, mime_type: this._mimeType, date: today });
  }

  // POST a store payload and render the outcome. Accepts either the fast path
  // ({ transcript, date }) or the Whisper fallback ({ audio_base64, mime_type,
  // date }); the server handles both shapes.
  async _postStore(body) {
    try {
      const resp = await fetch(STORE_URL, {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || `Could not save (HTTP ${resp.status}).`);
      }
      this._showResult(data);
      this._onStored(data);
    } catch (err) {
      this._showError(err.message || 'Could not save the capture. Try again.');
    }
  }

  _showResult(data) {
    this._setState('saved');
    this._setLiveNote('');
    this._setStatusLabel('Captured');
    this._resetRecordButton();
    this._recordBtn.disabled = false;
    this._setHint('Capture again');

    const count = data.items_extracted || 0;
    const ack   = (data.ack || '').trim();

    const $controls = this._root.querySelector('.vs-controls');
    const result = document.createElement('div');
    result.className = 'vs-result';
    result.innerHTML = `
      ${ack ? `<div class="vs-result-ack">${esc(ack)}</div>` : ''}
      <div class="vs-result-meta">
        ${count ? `<span class="vs-result-count">${count} ${count === 1 ? 'piece' : 'pieces'}</span>` : ''}
        <a class="vs-result-link" href="/twin/library">View in Library &rarr;</a>
      </div>
    `;
    this._clearResult();
    this._root.insertBefore(result, $controls);
  }

  _showError(msg) {
    this._setState('error');
    this._setLiveNote('');
    this._setStatusLabel('Ready');
    this._teardownAudio();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    clearInterval(this._timerId);
    clearTimeout(this._capId);
    this._resetRecordButton();
    this._recordBtn.disabled = false;
    this._setHint('Try again');
    this._hideTimer();

    const $controls = this._root.querySelector('.vs-controls');
    const err = document.createElement('div');
    err.className = 'vs-error';
    err.textContent = msg;
    this._clearResult();
    this._root.insertBefore(err, $controls);
  }

  _clearResult() {
    this._root?.querySelectorAll('.vs-result, .vs-error').forEach(el => el.remove());
  }

  // ── Visualisation loop ───────────────────────────────────────────────────────
  _startLoop() {
    const loop = () => {
      if (this._destroyed) return;
      this._draw();
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _draw() {
    const ctx = this._ctx2d;
    if (!ctx) return;
    const t = performance.now();
    const cssW = this._cssW || 300, cssH = this._cssH || 300;
    const cx = cssW / 2, cy = cssH / 2;
    const minDim = Math.min(cssW, cssH);

    ctx.clearRect(0, 0, cssW, cssH);

    // Safety net: if the context is still suspended (e.g. autoplay policy),
    // nudge it back so the shape starts reacting the moment it unlocks.
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }

    const listening = this._state === 'listening' && this._analyser;

    // Targets for bars + core
    let targetBars, targetCore;
    if (listening) {
      this._analyser.getByteFrequencyData(this._freqData);
      this._analyser.getByteTimeDomainData(this._timeData);
      // RMS amplitude from time-domain data → core pulse
      let sum = 0;
      for (let i = 0; i < this._timeData.length; i++) {
        const v = (this._timeData[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / this._timeData.length);
      // The analyser is live and producing data; note if it ever sees real
      // audio energy, so a silent mic can be called out plainly on stop.
      this._vizSampled = true;
      if (rms > 0.015) this._sawSignal = true;
      this._amp += (Math.min(1, rms * 3.2) - this._amp) * 0.25;
      targetCore = 1 + this._amp * 0.55;
      const bins = this._freqData.length;
      const maxBin = Math.floor(bins * 0.62); // speech-weighted range
      targetBars = (i) => {
        const bin = 2 + Math.floor((i / N_BARS) * (maxBin - 2));
        return Math.pow(this._freqData[bin] / 255, 1.35);
      };
      this._rotation += 0.0016;
    } else {
      // Calm idle: a slow breathing core and a gentle travelling ripple.
      this._amp += (0 - this._amp) * 0.08;
      targetCore = 1 + 0.045 * Math.sin(t * 0.0012);
      targetBars = (i) => 0.05 + 0.035 * (0.5 + 0.5 * Math.sin(t * 0.0014 + i * 0.42));
      this._rotation += 0.0004;
    }

    // Smooth toward targets
    this._coreScale += (targetCore - this._coreScale) * 0.2;
    for (let i = 0; i < N_BARS; i++) {
      const target = targetBars(i);
      this._bars[i] += (target - this._bars[i]) * (listening ? 0.4 : 0.08);
    }

    const baseR    = minDim * 0.155;
    const barBaseR = minDim * 0.205;
    const maxBarLen = minDim * 0.215;
    const coreR    = baseR * this._coreScale;

    // Energy halo (Luto yellow) — only when there's real signal
    if (this._amp > 0.04) {
      const haloR = barBaseR + maxBarLen * 0.9;
      const g = ctx.createRadialGradient(cx, cy, coreR, cx, cy, haloR);
      g.addColorStop(0, `rgba(245, 197, 0, ${Math.min(0.32, this._amp * 0.42)})`);
      g.addColorStop(1, 'rgba(245, 197, 0, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Radial bars (coral)
    ctx.lineCap = 'round';
    const barW = Math.max(2, minDim * 0.013);
    ctx.lineWidth = barW;
    for (let i = 0; i < N_BARS; i++) {
      const a = (i / N_BARS) * Math.PI * 2 + this._rotation - Math.PI / 2;
      const len = this._bars[i] * maxBarLen;
      const ca = Math.cos(a), sa = Math.sin(a);
      const x1 = cx + ca * barBaseR,        y1 = cy + sa * barBaseR;
      const x2 = cx + ca * (barBaseR + len), y2 = cy + sa * (barBaseR + len);
      ctx.strokeStyle = `rgba(255, 90, 60, ${0.45 + this._bars[i] * 0.55})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Core — coral disc with a soft highlight and an ink outline
    const cg = ctx.createRadialGradient(
      cx - coreR * 0.3, cy - coreR * 0.35, coreR * 0.1,
      cx, cy, coreR
    );
    cg.addColorStop(0, '#ff8a72');
    cg.addColorStop(1, '#ff5a3c');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#0F0E0D';
    ctx.stroke();
  }

  _resizeCanvas() {
    if (!this._canvas) return;
    const rect = this._canvas.getBoundingClientRect();
    const size = Math.max(40, Math.min(rect.width, rect.height));
    this._cssW = size;
    this._cssH = size;
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width  = Math.round(size * dpr);
    this._canvas.height = Math.round(size * dpr);
    this._canvas.style.width  = size + 'px';
    this._canvas.style.height = size + 'px';
    this._ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── State + small UI helpers ────────────────────────────────────────────────
  _setState(s) {
    this._state = s;
    if (this._root) this._root.dataset.state = s;
    if (s === 'listening') { this._setStatusLabel('Listening'); this._showTimer(); }
  }
  _setStatusLabel(text) {
    const el = this._root?.querySelector('.vs-state-label');
    if (el) el.textContent = text;
  }
  _setHint(text) {
    const el = this._root?.querySelector('.vs-hint');
    if (el) el.textContent = text;
  }
  _resetRecordButton() {
    const stop = this._recordBtn?.querySelector('.vs-record-stop');
    if (stop) stop.innerHTML = '';
  }
  _showTimer() {
    const el = this._root?.querySelector('.vs-timer');
    if (el) { el.hidden = false; el.textContent = '0:00'; }
  }
  _hideTimer() {
    const el = this._root?.querySelector('.vs-timer');
    if (el) el.hidden = true;
  }
  _tickTimer() {
    if (!this._startedAt) return;
    const el = this._root?.querySelector('.vs-timer');
    if (!el) return;
    const s = Math.floor((Date.now() - this._startedAt) / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  async _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(String(r.result).split(',', 2)[1] || null);
      r.onerror = reject;
      r.readAsDataURL(blob);
    }).catch(() => null);
  }

  _teardownAudio() {
    // Stop the live Web Speech recognizer (guarded so onend won't restart it).
    if (this._speech) {
      this._speechFatal = true;
      try { this._speech.onend = null; } catch {}
      try { this._speech.stop(); } catch {}
      this._speech = null;
    }
    if (this._recorder && this._recorder.state !== 'inactive') { try { this._recorder.stop(); } catch {} }
    this._recorder = null;
    if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
    if (this._source) { try { this._source.disconnect(); } catch {} this._source = null; }
    if (this._audioCtx) { try { this._audioCtx.close(); } catch {} this._audioCtx = null; }
    this._analyser = null;
  }

  // ── Cancel an in-flight capture (e.g. user navigates away) ───────────────────
  cancel() {
    if (this._state !== 'listening' && this._state !== 'saving') return;
    clearInterval(this._timerId);
    clearTimeout(this._capId);
    this._teardownAudio();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._clearResult();
    this._transcript = ''; this._interim = '';
    this._setLiveNote('');
    this._renderTranscript();
    this._setState('idle');
    this._setStatusLabel('Ready');
    this._resetRecordButton();
    if (this._recordBtn) this._recordBtn.disabled = false;
    this._setHint('Think out loud');
    this._hideTimer();
  }

  destroy() {
    this._destroyed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this.cancel();
    if (this._ro) { try { this._ro.disconnect(); } catch {} this._ro = null; }
    if (this._root) { this._root.remove(); this._root = null; }
  }
}
