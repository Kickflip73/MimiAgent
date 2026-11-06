/** PCM16LE can be split at any byte boundary by HTTP. */
export function pcmDecoder() {
  let carry = null, samples = 0;
  return {
    push(bytes) {
      let data = bytes;
      if (carry !== null) { data = new Uint8Array(bytes.length + 1); data[0] = carry; data.set(bytes, 1); }
      const count = Math.floor(data.length / 2), out = new Float32Array(count);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
      carry = data.length % 2 ? data[data.length - 1] : null;
      samples += count;
      return out;
    },
    finish() { if (carry !== null || !samples) throw new Error('语音流不完整'); },
  };
}
/** Network packets are not playback boundaries. Queue PCM on one continuous clock. */
export function createPcmPlayback(context, onState = () => {}) {
  const rate = 24000, block = 4800, fade = 0.005;
  const gain = context.createGain(); gain.connect(context.destination);
  const chunks = [], sources = new Set();
  let pending = 0, offset = 0, cursor = 0, started = false, threshold = 0.8, stopped = false;
  let firstPacketAt, received = 0, assessed = false;
  function drain(final = false) {
    if (stopped) return;
    if (started && cursor < context.currentTime + 0.03) {
      started = false; threshold = Math.min(3.2, threshold + 0.8);
      onState('正在缓冲语音…');
    }
    if (!started && !final && pending < rate * threshold) return;
    while (pending >= block || (final && pending)) {
      const count = Math.min(block, pending), pcm = new Float32Array(count);
      let written = 0;
      while (written < count) {
        const chunk = chunks[0], take = Math.min(count - written, chunk.length - offset);
        pcm.set(chunk.subarray(offset, offset + take), written); offset += take; written += take;
        if (offset === chunk.length) { chunks.shift(); offset = 0; }
      }
      pending -= count;
      if (!started) {
        cursor = Math.max(cursor, context.currentTime + 0.04);
        gain.gain.setValueAtTime(0, cursor);
        gain.gain.linearRampToValueAtTime(1, cursor + Math.min(fade, count / rate / 2));
        started = true; onState('正在朗读');
      } else {
        // Remove the previous tail fade before it occurs; ordinary joins stay sample-continuous.
        gain.gain.cancelScheduledValues(cursor - fade);
        gain.gain.setValueAtTime(1, cursor - fade);
      }
      const buffer = context.createBuffer(1, count, rate); buffer.copyToChannel(pcm, 0);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
      sources.add(source); source.onended = () => { sources.delete(source); source.disconnect(); };
      source.start(cursor); cursor += count / rate;
      gain.gain.setValueAtTime(1, cursor - Math.min(fade, count / rate / 2));
      gain.gain.linearRampToValueAtTime(0, cursor);
    }
  }
  return {
    push(pcm) {
      if (stopped || !pcm.length) return;
      firstPacketAt ??= context.currentTime;
      chunks.push(pcm); pending += pcm.length; received += pcm.length;
      if (!assessed && received >= rate * 0.8) {
        assessed = true;
        const elapsed = context.currentTime - firstPacketAt;
        // Faster speech consumes audio sooner. Estimate supply from actual arrivals, not an engine label.
        if (elapsed > 0) threshold = Math.min(3.2, Math.max(0.8, 0.8 + (1 - received / rate / elapsed) * 12));
      }
      drain();
    },
    finish() { drain(true); },
    get endTime() { return cursor; },
    get queuedSeconds() { return Math.max(0, cursor - context.currentTime) + pending / rate; },
    stop() {
      stopped = true; chunks.length = 0; pending = 0;
      for (const source of sources) { try { source.stop(); } catch {} source.disconnect(); }
      sources.clear(); gain.disconnect();
    },
  };
}

let active, primed, primedTimer, armedSession;
/** Rendering time leads the physical output device. Closing on currentTime clips its tail. */
export async function drainSpeechOutput(context, endTime, stopped, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  while (!stopped() && context.currentTime < endTime) await wait(20);
  if (stopped()) return;
  const outputTime = () => context.getOutputTimestamp?.().contextTime;
  if (outputTime() > 0) {
    while (!stopped() && outputTime() < endTime) await wait(20);
  } else {
    await wait(Math.max(100, ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000 + 50));
  }
}
// Unlock audio during the Send gesture, without generating or playing anything.
export function armSpeechPlayback(session) {
  armedSession = session;
  if (primed?.state === 'running') return;
  primed?.close().catch(() => {});
  try {
    const context = new AudioContext({ sampleRate: 24000 }); primed = context;
    context.resume().catch(() => {});
    clearTimeout(primedTimer);
    primedTimer = setTimeout(() => { if (primed === context) { primed = null; context.close().catch(() => {}); } }, 600000);
  } catch {}
}
export function stopSpeech() { active?.stop(); }
export function speechButton(text, options = {}, playback = {}) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'icon-button copy-button speech-button';
  const paint = playing => {
    button.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    button.title = playing ? '停止朗读' : '朗读';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(playing));
  };
  paint(false);
  const reportFailure = message => {
    paint(false);
    button.title = `朗读失败：${message}`;
    button.setAttribute('aria-label', button.title);
    playback.onState?.(button.title);
    playback.onError?.(button.title);
  };
  const start = async (automatic = false) => {
    if (active?.button === button) { stopSpeech(); return; }
    stopSpeech();
    const controller = new AbortController();
    let context;
    try {
      context = primed && primed.state !== 'closed' ? primed : new AudioContext({ sampleRate: 24000 });
    } catch (error) {
      primed = null; clearTimeout(primedTimer);
      reportFailure(error.message || '浏览器无法初始化音频设备');
      return;
    }
    primed = null; clearTimeout(primedTimer);
    if (automatic && context.state !== 'running') {
      context.close().catch(() => {});
      playback.onState?.('点击播放，浏览器需要一次点击以启用声音');
      return;
    }
    const sources = new Set();
    let stopped = false, cursor = context.currentTime, reader, failure, pcmPlayback;
    const run = { button, stop(announce = true) {
      if (stopped) return;
      stopped = true; controller.abort();
      for (const source of sources) { try { source.stop(); } catch {} }
      pcmPlayback?.stop();
      reader?.cancel().catch(() => {});
      context.close().catch(() => {});
      observer.disconnect();
      paint(false);
      if (active === run) active = null;
      if (announce) playback.onState?.('已停止；可从头播放');
    } };
    const observer = new MutationObserver(() => { if (!button.isConnected) run.stop(); });
    observer.observe(document.body, { subtree: true, childList: true });
    active = run; paint(true);
    const updateState = message => {
      if (!stopped) button.title = message === '正在朗读' ? '停止朗读' : message;
      playback.onState?.(message);
    };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      // Resume within the click gesture, including on HTTP custom domains.
      await context.resume();
      document.querySelectorAll('audio,video').forEach(media => media.pause());
      updateState('正在准备语音；可点击取消');
      const response = playback.url ? await fetch(playback.url, { signal: controller.signal }) : await fetch('/api/speech/stream', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mimi-web': '1' },
        body: JSON.stringify({ text: typeof text === 'function' ? text() : text, options: typeof options === 'function' ? options() : options }), signal: controller.signal });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error || `语音服务不可用（HTTP ${response.status}）`);
      }
      const schedule = buffer => {
        const source = context.createBufferSource();
        source.buffer = buffer; source.connect(context.destination);
        sources.add(source); source.onended = () => { sources.delete(source); source.disconnect(); };
        cursor = Math.max(cursor, context.currentTime + 0.03);
        source.start(cursor); cursor += buffer.duration;
        updateState('正在朗读');
      };
      if (response.headers.get('content-type')?.split(';')[0] === 'audio/wav') {
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (!stopped) schedule(buffer);
      } else {
      if (!response.body || response.headers.get('x-sample-rate') !== '24000'
        || response.headers.get('x-sample-format') !== 's16le') throw new Error('不支持的语音格式');
      reader = response.body.getReader();
      const decoder = pcmDecoder();
      pcmPlayback = createPcmPlayback(context, updateState);
      while (!stopped) {
        // Bound the queued audio; network backpressure reaches the synthesizer.
        while (!stopped && pcmPlayback.queuedSeconds > 5) await wait(50);
        if (stopped) break;
        const { value, done } = await reader.read();
        if (done) { decoder.finish(); pcmPlayback.finish(); cursor = pcmPlayback.endTime; break; }
        const pcm = decoder.push(value);
        if (!pcm.length) continue;
        pcmPlayback.push(pcm); cursor = pcmPlayback.endTime;
      }
      }
      await drainSpeechOutput(context, cursor, () => stopped, wait);
    } catch (error) {
      if (!stopped) failure = error.message || '播放未完成，请重新点击朗读';
    } finally {
      const alreadyStopped = stopped;
      run.stop(false);
      // A stop/save/new playback already owns the UI; this old async tail must not overwrite it.
      if (!alreadyStopped) {
        if (failure) reportFailure(failure);
        else playback.onState?.('朗读结束；可再次播放');
      }
    }
  };
  button.addEventListener('click', () => start());
  button.startSpeech = () => start(true);
  return button;
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { stopSpeech(); primed?.close().catch(() => {}); primed = null; clearTimeout(primedTimer); });
  window.addEventListener('play', event => { if (['AUDIO', 'VIDEO'].includes(event.target?.tagName)) stopSpeech(); }, true);
}

export function liveSpeechPlayer(session, audioId, autoplay = false) {
  const node = document.createElement('div'); node.className = 'live-speech-player';
  const status = document.createElement('span'); status.textContent = '语音已开始生成，点击可边生成边播放';
  status.setAttribute('role', 'status');
  const button = speechButton('', {}, { url: `/api/speech/live?session=${encodeURIComponent(session)}&id=${encodeURIComponent(audioId)}`,
    onState: message => { status.textContent = message; } });
  node.append(button, status);
  if (autoplay && armedSession === session) queueMicrotask(() => { if (node.isConnected) void button.startSpeech(); });
  return node;
}
