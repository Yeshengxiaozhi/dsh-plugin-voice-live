window.__ModuleLoader__.load({
  id: 'dsh-plugin-voice-live',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'voice-live';
    const STORE_KEY = 'dsh.voice-live.settings.v2';
    const DEFAULT_SETTINGS = {
      url: 'http://127.0.0.1:8020',
      asrUrl: 'http://127.0.0.1:8031',
      voice: 'Serena',
      language: 'Chinese',
      asr: 'zh',
      instruct: '用轻松口语化的语气，像朋友之间快速聊天，语速偏快，句子之间不要拖，不要播音腔。',
      rate: 1.08,
      streamAudio: false,
    };
    const VOICES = [
      'Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric',
      'Ryan', 'Aiden', 'Ono_Anna', 'Sohee',
    ];

    const zh = {
      toggle: '实时语音对话', label: '语音对话', start: '开始对话', stop: '结束对话', interrupt: '打断',
      settings: '设置', close: '关闭',
      idle: '点一下开始，说话后停顿会自动发送',
      listening: '在听…', transcribing: '识别中…', thinking: '思考中…', speaking: '正在说…',
      interruptHint: '正在说…（直接说话可以打断）',
      service: 'TTS 服务地址', asrService: '识别服务地址', voice: '音色', language: '语言', save: '保存', saved: '已保存',
      tone: '语气（自然语言描述）', lowLatency: '低延迟模式（更跟手，但每 0.5 秒有一个接缝）',
      hint: '先在本机运行 tools/tts_server.py，再开始对话。',
      noSpeech: '语音识别服务不可用：请先在插件页启用语音输入（SenseVoice）。',
      noTts: '连不上 TTS 服务，检查地址和 tools/tts_server.py 是否在运行。',
      empty: '没有听清，再说一次。',
      you: '你', me: '我',
    };
    const en = {
      toggle: 'Realtime voice', label: 'Voice', start: 'Start talking', stop: 'End conversation', interrupt: 'Interrupt',
      settings: 'Settings', close: 'Close',
      idle: 'Tap to start. Pause after speaking to send.',
      listening: 'Listening…', transcribing: 'Transcribing…', thinking: 'Thinking…', speaking: 'Speaking…',
      interruptHint: 'Speaking… (talk to interrupt)',
      service: 'TTS endpoint', asrService: 'ASR endpoint', voice: 'Voice', language: 'Language', save: 'Save', saved: 'Saved',
      tone: 'Tone (plain-language instruction)', lowLatency: 'Low latency (snappier, one seam every 0.5s)',
      hint: 'Start tools/tts_server.py locally before talking.',
      noSpeech: 'Speech recognition is unavailable: enable the voice input bundle (SenseVoice) first.',
      noTts: 'Cannot reach the TTS endpoint. Check the URL and that tools/tts_server.py is running.',
      empty: "Didn't catch that. Try again.",
      you: 'You', me: 'Me',
    };

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
      } catch (_error) {
        return Object.assign({}, DEFAULT_SETTINGS);
      }
    }

    function writeSettings(next) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch (_error) {
        /* storage unavailable: keep the in-memory copy */
      }
    }

    function downsample(input, fromRate, toRate) {
      if (fromRate === toRate) return input;
      const ratio = fromRate / toRate;
      const length = Math.floor(input.length / ratio);
      const out = new Float32Array(length);
      for (let i = 0; i < length; i += 1) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += input[j];
        out[i] = end > start ? sum / (end - start) : 0;
      }
      return out;
    }

    function encodeWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);
      const text = (offset, value) => {
        for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
      };
      text(0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      text(8, 'WAVE');
      text(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      let offset = 44;
      for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
      return new Uint8Array(buffer);
    }

    function base64(bytes) {
      let out = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return window.btoa(out);
    }

    function stripMarkup(input) {
      return String(input)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_#>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /** End offset of the first speakable sentence in the buffer, or -1. */
    function sentenceEnd(buffer, allowComma) {
      let fenced = false;
      for (let i = 0; i < buffer.length; i += 1) {
        if (buffer.startsWith('```', i)) {
          fenced = !fenced;
          i += 2;
          continue;
        }
        if (fenced) continue;
        const ch = buffer[i];
        if (allowComma && (ch === '，' || ch === ',')) {
          if (i >= 6) return i + 1;
          continue;
        }
        if ('。！？!?；;'.indexOf(ch) >= 0) {
          if (i >= 11) return i + 1;
          continue;
        }
        if (ch === '\n') {
          if (i >= 11) return i + 1;
          continue;
        }
        if (ch === '.' && /^\s/.test(buffer.slice(i + 1, i + 2)) && i >= 12) return i + 1;
      }
      return -1;
    }

    function createEngine(cfg) {
      const st = {
        active: false,
        muted: false,
        ac: null,
        gain: null,
        stream: null,
        micSource: null,
        processor: null,
        sink: null,
        binding: null,
        reference: null,
        unsubscribe: null,
        cursor: 0,
        lastLength: 0,
        pendingText: '',
        replyText: '',
        chain: Promise.resolve(),
        ttsAbort: null,
        playing: [],
        playCursor: 0,
        sampleRate: 24000,
        rate: 1,
        chunks: [],
        chunkSamples: 0,
        voicedMs: 0,
        silentMs: 0,
        speaking: false,
        noise: 0.008,
        pendingCount: 0,
        idleTimer: null,
        bargeFrames: 0,
        echo: null,
        hpX: 0,
        hpY: 0,
        cooldownUntil: 0,
        spokeThisTurn: false,
        suppress: false,
        cancelPending: null,
        disposed: false,
      };

      function status(next) {
        if (st.disposed) return;
        cfg.emit.status(next);
      }

      function report(error) {
        if (st.disposed) return;
        if (error && (error.name === 'AbortError' || error.code === 20)) return;
        cfg.emit.error(cfg.describe(error));
      }

      async function ensureAudio() {
        if (!st.ac) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          st.ac = new Ctor();
          st.gain = st.ac.createGain();
          st.gain.gain.value = 1;
          st.gain.connect(st.ac.destination);
        }
        if (st.ac.state === 'suspended') await st.ac.resume();
        return st.ac;
      }

      function stopPlaying() {
        for (const node of st.playing.slice()) {
          try { node.stop(); } catch (_error) { /* already stopped */ }
        }
        st.playing.length = 0;
        st.playCursor = 0;
      }

      function abortSpeech() {
        if (st.ttsAbort) {
          try { st.ttsAbort.abort(); } catch (_error) { /* ignore */ }
          st.ttsAbort = null;
        }
        st.pendingCount = 0;
        st.chain = Promise.resolve();
        stopPlaying();
      }

      // ---------- microphone ----------

      function trimPreroll() {
        const max = st.ac.sampleRate * 0.5;
        while (st.chunkSamples > max && st.chunks.length > 1) {
          st.chunkSamples -= st.chunks.shift().length;
        }
      }

      function takeUtterance() {
        const out = new Float32Array(st.chunkSamples);
        let offset = 0;
        for (const chunk of st.chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        st.chunks = [];
        st.chunkSamples = 0;
        st.voicedMs = 0;
        st.silentMs = 0;
        st.speaking = false;
        return out;
      }

      function onAudio(event) {
        if (!st.active || st.disposed) return;
        const frame = event.inputBuffer.getChannelData(0);
        const rate = st.ac.sampleRate;
        const frameMs = (frame.length / rate) * 1000;
        const playing = st.pendingCount > 0 || st.playing.length > 0;

        // One-pole high-pass (~220 Hz) before measuring level: bumping the mic
        // produces a low-frequency thump that speech never reaches.
        let sum = 0;
        let prevX = st.hpX;
        let prevY = st.hpY;
        for (let i = 0; i < frame.length; i += 1) {
          const x = frame[i];
          const y = 0.97 * (prevY + x - prevX);
          prevX = x;
          prevY = y;
          sum += y * y;
        }
        st.hpX = prevX;
        st.hpY = prevY;
        const rms = Math.sqrt(sum / frame.length);

        st.chunks.push(frame.slice(0));
        st.chunkSamples += frame.length;

        if (playing) {
          // Keep listening while the reply plays. The gate tracks our own echo
          // instead of the room: it rises when the speaker leaks into the mic and
          // stays put when the user talks over it.
          while (st.chunkSamples > rate * 0.45 && st.chunks.length > 1) {
            st.chunkSamples -= st.chunks.shift().length;
          }
          if (st.echo === null) st.echo = Math.max(0.006, st.noise);
          const gate = Math.max(0.03, st.echo * 2);
          if (rms > gate) {
            st.bargeFrames += 1;
          } else {
            st.bargeFrames = 0;
            st.echo = st.echo * 0.9 + rms * 0.1;
          }
          if (st.bargeFrames >= 3) {
            st.bargeFrames = 0;
            st.echo = null;
            bargeIn();
          }
          return;
        }
        st.echo = null;

        const now = window.performance.now();
        const cooling = now < st.cooldownUntil;
        if (cooling) st.voicedMs = 0;
        if (!st.speaking && !cooling) {
          // Drop fast, rise slowly: a noisy moment must not leave the gate high
          // for seconds, or quiet syllables inside a sentence read as silence.
          st.noise = rms < st.noise ? st.noise * 0.85 + rms * 0.15 : st.noise * 0.99 + rms * 0.01;
        }
        // The cap is the real guarantee: close-talk speech always exceeds it.
        const threshold = Math.min(Math.max(0.011, st.noise * 3.2), 0.045);
        // Right after our own audio stops, the mic still carries its tail; a
        // gate that opens immediately turns that tail into a "user utterance".
        const voiced = !cooling && rms > threshold;

        if (!st.speaking) trimPreroll();

        if (voiced) {
          st.voicedMs += frameMs;
          st.silentMs = 0;
          if (!st.speaking && !cooling && st.voicedMs >= 250) {
            st.speaking = true;
            cancelIfRunning();
          }
        } else if (st.speaking) {
          st.silentMs += frameMs;
        }

        if (st.speaking && st.silentMs > 2000) {
          const utterance = takeUtterance();
          if (utterance.length > rate * 0.7) {
            void handleUtterance(utterance);
          } else {
            status('listening');
          }
        }
      }

      /** Speaking while the agent is still working cancels that turn. */
      function cancelIfRunning() {
        const session = st.binding && st.binding.session;
        if (!session || typeof session.getSnapshot !== 'function') return;
        const snapshot = session.getSnapshot();
        if (!snapshot || !snapshot.running) return;
        st.suppress = true;
        abortSpeech();
        if (typeof session.cancel === 'function') {
          st.cancelPending = Promise.resolve(session.cancel()).catch(() => undefined);
        }
        status('listening');
      }

      /** The user started talking over the reply: stop the audio and cancel the turn. */
      function bargeIn() {
        abortSpeech();
        // Drop everything but the user's first syllable: the tail of the buffer
        // can still carry our own voice leaking past the echo canceller.
        while (st.chunkSamples > st.ac.sampleRate * 0.3 && st.chunks.length > 1) {
          st.chunkSamples -= st.chunks.shift().length;
        }
        st.speaking = true;
        st.suppress = true;
        st.voicedMs = 90;
        st.silentMs = 0;
        status('listening');
        const session = st.binding && st.binding.session;
        if (session && typeof session.cancel === 'function') {
          st.cancelPending = Promise.resolve(session.cancel()).catch(() => undefined);
        }
      }


      async function startMic() {
        const ac = await ensureAudio();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        st.stream = stream;
        st.micSource = ac.createMediaStreamSource(stream);
        st.processor = ac.createScriptProcessor(2048, 1, 1);
        st.processor.onaudioprocess = onAudio;
        st.sink = ac.createGain();
        st.sink.gain.value = 0;
        st.micSource.connect(st.processor);
        st.processor.connect(st.sink);
        st.sink.connect(ac.destination);
      }

      function stopMic() {
        if (st.processor) {
          try { st.processor.disconnect(); } catch (_error) { /* ignore */ }
          st.processor.onaudioprocess = null;
          st.processor = null;
        }
        if (st.micSource) {
          try { st.micSource.disconnect(); } catch (_error) { /* ignore */ }
          st.micSource = null;
        }
        if (st.sink) {
          try { st.sink.disconnect(); } catch (_error) { /* ignore */ }
          st.sink = null;
        }
        if (st.stream) {
          for (const track of st.stream.getTracks()) track.stop();
          st.stream = null;
        }
        st.chunks = [];
        st.chunkSamples = 0;
        st.voicedMs = 0;
        st.silentMs = 0;
        st.speaking = false;
      }

      // ---------- session ----------

      async function attachSession() {
        const sessions = cfg.runtime && cfg.runtime.sessions;
        if (!sessions) throw new Error('sessions service unavailable');
        const existing = sessions.binding(cfg.sessionId);
        if (existing) {
          st.binding = existing;
        } else {
          const reference = sessions.retain(cfg.sessionId, { source: 'voice-live' });
          st.reference = reference;
          const binding = reference.binding || (await reference.ready);
          st.binding = binding;
        }
        const source = st.binding.eventSource;
        if (!source) throw new Error('session event source unavailable');
        st.unsubscribe = source.subscribe(() => onWindow(source.getSnapshot()));
        const initial = source.getSnapshot();
        st.cursor = initial && initial.entries ? initial.entries.length : 0;
        st.lastLength = st.cursor;
      }

      function detachSession() {
        if (st.unsubscribe) {
          try { st.unsubscribe(); } catch (_error) { /* ignore */ }
          st.unsubscribe = null;
        }
        if (st.reference) {
          try { st.reference.release(); } catch (_error) { /* ignore */ }
          st.reference = null;
        }
        st.binding = null;
      }

      function onWindow(window) {
        if (!window || !window.entries) return;
        const entries = window.entries;
        const kind = window.change && window.change.kind;

        if (kind === 'replace' || entries.length < st.cursor) {
          st.cursor = entries.length;
          st.pendingText = '';
        } else if (kind === 'prepend') {
          st.cursor += entries.length - st.lastLength;
          if (st.cursor < 0) st.cursor = 0;
        }

        for (; st.cursor < entries.length; st.cursor += 1) handleEntry(entries[st.cursor]);
        st.lastLength = entries.length;
      }

      function handleEntry(entry) {
        const event = entry && entry.event;
        if (!event) return;
        if (entry.type === 'transient') {
          if (event.type !== 'assistant/live-chunk') return;
          const chunk = event.data && event.data.chunk;
          if (!chunk) return;
          if (chunk.type === 'text-delta') feed(chunk.text);
          else if (chunk.type === 'finish') flush();
          return;
        }
        if (event.type === 'turn/start') {
          st.replyText = '';
          st.suppress = false;
          st.spokeThisTurn = false;
          cfg.emit.reply('');
          return;
        }
        if (event.type === 'turn/end' || event.type === 'assistant/message') flush();
        if (event.type === 'turn/end') {
          st.suppress = false;
          if (cfg.getStatus() === 'thinking') status('listening');
        }
      }

      function feed(text) {
        if (!st.active || !text) return;
        st.replyText += text;
        cfg.emit.reply(st.replyText.slice(-240));
        if (st.suppress) return;
        st.pendingText += text;
        for (;;) {
          // The opening segment is cut at a comma so the first sound arrives
          // while the rest of the paragraph is still being synthesized.
          const end = sentenceEnd(st.pendingText, !st.spokeThisTurn);
          if (end <= 0) break;
          const sentence = st.pendingText.slice(0, end);
          st.pendingText = st.pendingText.slice(end);
          st.spokeThisTurn = true;
          enqueue(sentence);
        }
      }

      function flush() {
        const rest = st.pendingText;
        st.pendingText = '';
        if (!st.suppress && rest.trim()) enqueue(rest);
      }

      // ---------- speech out ----------

      function enqueue(raw) {
        const text = stripMarkup(raw);
        if (!text) return;
        const clipped = text.length > 220 ? text.slice(0, 220) : text;
        st.pendingCount += 1;
        st.chain = st.chain
          .then(() => speakOne(clipped))
          .catch((error) => report(error))
          .then(() => {
            st.pendingCount = Math.max(0, st.pendingCount - 1);
            pumpIdle();
          });
      }

      function pumpIdle() {
        if (st.idleTimer) window.clearTimeout(st.idleTimer);
        st.idleTimer = window.setTimeout(() => {
          st.idleTimer = null;
          if (st.disposed || !st.active) return;
          if (st.pendingCount > 0 || st.playing.length > 0) {
            pumpIdle();
            return;
          }
          st.echo = null;
          st.cooldownUntil = window.performance.now() + 600;
          status('listening');
        }, 220);
      }

      function playPcm(bytes, rate) {
        if (!st.ac) return;
        const count = bytes.length >> 1;
        if (!count) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
        const buffer = st.ac.createBuffer(1, count, rate);
        buffer.copyToChannel(samples, 0);
        const node = st.ac.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = st.rate || 1;
        node.connect(st.gain);
        const now = st.ac.currentTime;
        if (st.playCursor < now + 0.06) st.playCursor = now + 0.06;
        node.start(st.playCursor);
        st.playCursor += buffer.duration / (st.rate || 1);
        st.playing.push(node);
        node.onended = () => {
          const index = st.playing.indexOf(node);
          if (index >= 0) st.playing.splice(index, 1);
        };
      }

      async function speakOne(text) {
        if (!st.active || st.disposed) return;
        const settings = cfg.getSettings();
        const controller = new AbortController();
        st.ttsAbort = controller;
        st.rate = Number(settings.rate) > 0 ? Number(settings.rate) : 1;
        status('speaking');
        const endpoint = String(settings.url || '').replace(/\/+$/, '') + '/v1/audio/speech';
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3-tts',
            input: text,
            voice: settings.voice,
            language: settings.language || 'Chinese',
            instruct: settings.instruct || undefined,
            stream_audio: Boolean(settings.streamAudio),
            response_format: 'pcm',
            stream: true,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error((detail || 'TTS HTTP ' + response.status).slice(0, 180));
        }
        const header = Number(response.headers.get('x-sample-rate'));
        const rate = Number.isFinite(header) && header > 0 ? header : 24000;
        st.sampleRate = rate;
        const reader = response.body.getReader();
        let carry = null;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          let bytes = part.value;
          if (carry && carry.length) {
            const merged = new Uint8Array(carry.length + bytes.length);
            merged.set(carry, 0);
            merged.set(bytes, carry.length);
            bytes = merged;
            carry = null;
          }
          if (bytes.length & 1) {
            carry = bytes.slice(bytes.length - 1);
            bytes = bytes.subarray(0, bytes.length - 1);
          }
          if (bytes.length) playPcm(bytes, rate);
        }
      }

      // ---------- turn ----------

      async function transcribe(wavBytes) {
        const settings = cfg.getSettings();
        const endpoint =
          String(settings.asrUrl || '').replace(/\/+$/, '') +
          '/v1/audio/transcriptions?language=' +
          encodeURIComponent(settings.asr || 'zh');
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: wavBytes,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error((detail || 'ASR HTTP ' + response.status).slice(0, 180));
        }
        const value = await response.json();
        return String((value && value.text) || '').trim();
      }

      async function prompt(text) {
        if (!st.binding) throw new Error('session not ready');
        const requestId =
          window.crypto && window.crypto.randomUUID
            ? window.crypto.randomUUID()
            : 'voice-live-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        if (st.cancelPending) {
          await st.cancelPending;
          st.cancelPending = null;
        }
        const session = st.binding.session;
        const snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null;
        const mode = snapshot && snapshot.running ? 'steer' : 'queue';
        const result = await session.prompt([{ type: 'text', text }], mode, undefined, requestId);
        if (result && result.ok === false) {
          throw new Error(result.error && result.error.message ? result.error.message : 'prompt failed');
        }
        status('thinking');
      }

      async function handleUtterance(samples) {
        status('transcribing');
        try {
          const wav = encodeWav(downsample(samples, st.ac.sampleRate, 16000), 16000);
          const text = await transcribe(wav);
          if (!text) {
            status('listening');
            cfg.emit.error(cfg.t('empty'));
            return;
          }
          cfg.emit.caption(text);
          await prompt(text);
        } catch (error) {
          report(error);
          status('listening');
        }
      }

      // ---------- lifecycle ----------

      async function start() {
        if (st.active) return;
        st.disposed = false;
        await ensureAudio();
        await attachSession();
        await startMic();
        st.active = true;
        status('listening');
      }

      function stop() {
        if (!st.active) return;
        st.active = false;
        abortSpeech();
        stopMic();
        detachSession();
        status('idle');
      }

      function interrupt() {
        abortSpeech();
        if (st.active) status('listening');
      }

      function dispose() {
        st.disposed = true;
        stop();
        if (st.ac) {
          try { st.ac.close(); } catch (_error) { /* ignore */ }
          st.ac = null;
        }
      }

      return {
        start,
        stop,
        interrupt,
        dispose,
        isActive: () => st.active,
      };
    }

    function useEngine(props) {
      const { sessionId, runtime, emit, t, getSettings, getStatus } = props;
      const holder = React.useRef(null);
      if (!holder.current || holder.current.sessionId !== sessionId) {
        const previous = holder.current;
        if (previous) {
          try { previous.engine.dispose(); } catch (_error) { /* already gone */ }
        }
        holder.current = {
          sessionId,
          engine: createEngine({ sessionId, runtime, emit, t, getSettings, getStatus, describe }),
        };
      }
      React.useEffect(() => () => {
        if (holder.current) {
          try { holder.current.engine.dispose(); } catch (_error) { /* already gone */ }
        }
      }, []);
      return {
        get current() {
          return holder.current ? holder.current.engine : null;
        },
      };
    }

    function describe(error) {
      if (!error) return '';
      if (error.code === 'no-speech') return 'SPEECH_UNAVAILABLE';
      const message = String(error.message || error);
      if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'TTS_UNREACHABLE';
      return message;
    }

    const CSS = `
      .vl-dock { display: flex; justify-content: flex-end; }
      .vl-btn {
        height: 32px; padding: 0 13px 0 10px; border-radius: 16px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        border: 1px solid transparent;
        background: var(--dsw-alias-brand-primary, #4d6bfe);
        color: #fff; font-size: 12px; font-weight: 600; letter-spacing: .02em;
        box-shadow: 0 2px 12px rgba(77, 107, 254, .32);
        transition: filter .15s, box-shadow .15s;
      }
      .vl-btn:hover { filter: brightness(1.1); }
      .vl-btn[data-on="true"] { filter: brightness(1.15); }
      .vl-btn-label { white-space: nowrap; }
      .vl-btn[data-live="true"] { animation: vlPulse 1.8s ease-in-out infinite; }
      @keyframes vlPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(77, 107, 254, 0); }
        50% { box-shadow: 0 0 0 6px rgba(77, 107, 254, 0.18); }
      }
      .vl-panel {
        position: fixed; right: 24px; bottom: 108px; width: 336px; z-index: 60;
        padding: 14px 16px 12px; border-radius: 18px;
        background: var(--dsw-alias-bg-overlay, #1c1c20);
        border: 1px solid var(--dsw-alias-border-l1, #33333a);
        box-shadow: 0 16px 48px rgba(0, 0, 0, .32);
        color: var(--dsw-alias-label-primary, #eceff4);
        font-size: 13px; line-height: 1.5;
        backdrop-filter: blur(14px);
      }
      .vl-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .vl-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #888); }
      .vl-dot[data-s="listening"] { background: var(--dsw-alias-state-success-primary, #3ecf8e); }
      .vl-dot[data-s="transcribing"], .vl-dot[data-s="thinking"] { background: var(--dsw-alias-state-warn-primary, #e8b23a); }
      .vl-dot[data-s="speaking"] { background: var(--dsw-alias-brand-primary, #4d6bfe); }
      .vl-state { font-weight: 600; }
      .vl-close { margin-left: auto; background: none; border: 0; color: var(--dsw-alias-label-secondary, #9aa0aa); cursor: pointer; font-size: 16px; line-height: 1; }
      .vl-body { max-height: 190px; overflow: auto; }
      .vl-line { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
      .vl-who { color: var(--dsw-alias-label-secondary, #9aa0aa); margin-right: 6px; font-size: 12px; }
      .vl-empty { color: var(--dsw-alias-label-secondary, #9aa0aa); }
      .vl-error { color: var(--dsw-alias-state-error-primary, #ff5c5c); margin: 6px 0 0; font-size: 12px; }
      .vl-bars { display: flex; align-items: flex-end; gap: 3px; height: 16px; margin: 4px 0 10px; }
      .vl-bars i { display: block; width: 3px; height: 4px; border-radius: 2px; background: var(--dsw-alias-brand-primary, #4d6bfe); opacity: .35; }
      .vl-bars[data-live="true"] i { animation: vlBar .9s ease-in-out infinite; opacity: .9; }
      .vl-bars[data-live="true"] i:nth-child(2) { animation-delay: .12s; }
      .vl-bars[data-live="true"] i:nth-child(3) { animation-delay: .24s; }
      .vl-bars[data-live="true"] i:nth-child(4) { animation-delay: .36s; }
      .vl-bars[data-live="true"] i:nth-child(5) { animation-delay: .48s; }
      @keyframes vlBar { 0%, 100% { height: 4px; } 50% { height: 15px; } }
      .vl-actions { display: flex; gap: 8px; margin-top: 10px; }
      .vl-act {
        flex: 1; padding: 6px 10px; border-radius: 9px; cursor: pointer; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l1, #33333a);
        background: transparent; color: var(--dsw-alias-label-primary, #eceff4);
      }
      .vl-act:hover { border-color: var(--dsw-alias-border-l2, #4a4a55); }
      .vl-act[data-primary="true"] { background: var(--dsw-alias-brand-primary, #4d6bfe); border-color: transparent; color: #fff; }
      .vl-form { display: grid; gap: 8px; margin-top: 10px; }
      .vl-form label { display: grid; gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary, #9aa0aa); }
      .vl-check { display: flex; align-items: center; gap: 8px; }
      .vl-check input { width: auto; }
      .vl-form input, .vl-form select {
        width: 100%; padding: 6px 8px; border-radius: 8px; font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l1, #33333a);
        background: var(--dsw-alias-bg-layer-1, #232329);
        color: var(--dsw-alias-label-primary, #eceff4);
      }
    `;

    function VoiceLive(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [status, setStatus] = React.useState('idle');
      const [caption, setCaption] = React.useState('');
      const [reply, setReply] = React.useState('');
      const [error, setError] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [showSettings, setShowSettings] = React.useState(false);
      const [settings, setSettings] = React.useState(readSettings);
      const settingsRef = React.useRef(settings);
      const statusRef = React.useRef(status);
      settingsRef.current = settings;
      statusRef.current = status;

      const engine = useEngine({
        sessionId: props.sessionId,
        runtime: props.runtime,
        getSettings: () => settingsRef.current,
        getStatus: () => statusRef.current,
        t,
        emit: {
          status: (next) => setStatus(next),
          caption: (text) => setCaption(text),
          reply: (text) => setReply(text),
          error: (text) => {
            if (text === 'SPEECH_UNAVAILABLE') setError(t('noSpeech'));
            else if (text === 'TTS_UNREACHABLE') setError(t('noTts'));
            else setError(text);
          },
        },
      });

      const live = status !== 'idle';

      const toggle = async () => {
        setError('');
        if (engine.current.isActive()) {
          engine.current.stop();
          setOpen(false);
          return;
        }
        setOpen(true);
        try {
          await engine.current.start();
        } catch (failure) {
          setError(describe(failure) === 'TTS_UNREACHABLE' ? t('noTts') : String(failure.message || failure));
          engine.current.stop();
        }
      };

      const save = () => {
        writeSettings(settings);
        setShowSettings(false);
        setError('');
      };

      return h(
        'div',
        { className: 'vl-dock' },
        h('style', { key: 'style', dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'vl-btn',
            'data-on': String(live),
            'data-live': String(status === 'listening' || status === 'speaking'),
            title: t('toggle'),
            'aria-label': t('toggle'),
            'aria-pressed': live,
            onMouseDown: (event) => event.preventDefault(),
            onClick: toggle,
          },
          h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3, fill: 'currentColor' }),
            h('path', {
              d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
            }),
          ),
          h('span', { className: 'vl-btn-label' }, t('label')),
        ),
        open
          ? h(
              'div',
              { key: 'panel', className: 'vl-panel', role: 'dialog', 'aria-label': t('toggle') },
              h(
                'div',
                { className: 'vl-head' },
                h('span', { className: 'vl-dot', 'data-s': status }),
                h(
                  'span',
                  { className: 'vl-state' },
                  t(status === 'speaking' ? 'interruptHint' : status === 'idle' ? 'idle' : status),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'vl-close',
                    'aria-label': t('close'),
                    onClick: () => {
                      engine.current.stop();
                      setOpen(false);
                    },
                  },
                  '×',
                ),
              ),
              h(
                'div',
                { className: 'vl-bars', 'data-live': String(status === 'listening' || status === 'speaking') },
                h('i'),
                h('i'),
                h('i'),
                h('i'),
                h('i'),
              ),
              h(
                'div',
                { className: 'vl-body' },
                caption
                  ? h('p', { className: 'vl-line' }, h('span', { className: 'vl-who' }, t('you')), caption)
                  : h('p', { className: 'vl-line vl-empty' }, t('idle')),
                reply ? h('p', { className: 'vl-line' }, h('span', { className: 'vl-who' }, t('me')), reply) : null,
              ),
              error ? h('p', { className: 'vl-error', role: 'alert' }, error) : null,
              showSettings
                ? h(
                    'div',
                    { className: 'vl-form' },
                    h(
                      'label',
                      null,
                      t('service'),
                      h('input', {
                        type: 'url',
                        value: settings.url,
                        spellCheck: false,
                        onChange: (event) => setSettings(Object.assign({}, settings, { url: event.target.value })),
                      }),
                    ),
                    h(
                      'label',
                      null,
                      t('asrService'),
                      h('input', {
                        type: 'url',
                        value: settings.asrUrl,
                        spellCheck: false,
                        onChange: (event) => setSettings(Object.assign({}, settings, { asrUrl: event.target.value })),
                      }),
                    ),
                    h(
                      'label',
                      null,
                      t('voice'),
                      h(
                        'select',
                        {
                          value: settings.voice,
                          onChange: (event) => setSettings(Object.assign({}, settings, { voice: event.target.value })),
                        },
                        VOICES.map((voice) => h('option', { key: voice, value: voice }, voice)),
                      ),
                    ),
                    h(
                      'label',
                      null,
                      t('language'),
                      h(
                        'select',
                        {
                          value: settings.language,
                          onChange: (event) => setSettings(Object.assign({}, settings, { language: event.target.value })),
                        },
                        ['Chinese', 'English'].map((language) => h('option', { key: language, value: language }, language)),
                      ),
                    ),
                    h(
                      'label',
                      null,
                      t('tone'),
                      h('input', {
                        type: 'text',
                        value: settings.instruct || '',
                        spellCheck: false,
                        onChange: (event) => setSettings(Object.assign({}, settings, { instruct: event.target.value })),
                      }),
                    ),
                    h(
                      'label',
                      { className: 'vl-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: Boolean(settings.streamAudio),
                        onChange: (event) => setSettings(Object.assign({}, settings, { streamAudio: event.target.checked })),
                      }),
                      h('span', null, t('lowLatency')),
                    ),
                    h(
                      'div',
                      { className: 'vl-actions' },
                      h('button', { type: 'button', className: 'vl-act', 'data-primary': 'true', onClick: save }, t('save')),
                      h(
                        'button',
                        { type: 'button', className: 'vl-act', onClick: () => setShowSettings(false) },
                        t('close'),
                      ),
                    ),
                  )
                : h(
                    'div',
                    { className: 'vl-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'vl-act',
                        'data-primary': 'true',
                        onClick: () => engine.current.interrupt(),
                        disabled: !live,
                      },
                      t('interrupt'),
                    ),
                    h('button', { type: 'button', className: 'vl-act', onClick: () => setShowSettings(true) }, t('settings')),
                  ),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }));

      const runtime = () => ({
        sessions: ctx.get('sessions'),
        remote: ctx.get('remote'),
      });

      const Bound = (props) => h(VoiceLive, Object.assign({}, props, { runtime: runtime() }));

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'voice-live',
            order: 30,
            locale: NS,
          },
          Bound,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
