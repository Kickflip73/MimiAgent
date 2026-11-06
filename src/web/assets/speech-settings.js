import { randomUUID } from './uuid.js';
import { speechButton, stopSpeech } from './speech-stream.js';
import { enhanceSelects } from './pickers.js';
import { createRecorder } from './recorder.js';

const SAMPLE = '你好，我是咪咪。愿我的声音让每一次交流都自然、清晰。';
const ENGLISH_SAMPLE = 'Hello, I am Mimi. Take a breath and enjoy a quiet moment.';

/** Decode once in the browser; send a bounded, portable reference to the local service. */
export function voiceSampleWav(buffer) {
  if (buffer.duration < 1 || buffer.duration > 30) throw new Error('请选择 1～30 秒的声音，建议 5～15 秒');
  const bytes = new ArrayBuffer(44 + buffer.length * 2), view = new DataView(bytes);
  const word = (at, text) => [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, buffer.length * 2, true);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < buffer.length; i++) {
    const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function mountSpeechSettings(root) {
  const panel = document.createElement('section');
  panel.className = 'speech-settings';
  panel.innerHTML = '<h2>语音</h2><p role="status">正在读取语音设置…</p>';
  root.append(panel);
  const controller = new AbortController();
  const request = async (action, value) => {
    const response = await fetch('/api/speech/settings', { signal: controller.signal, ...(action ? {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mimi-web': '1' }, body: JSON.stringify({ action, value }),
    } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '语音设置失败');
    return result;
  };
  let catalog;
  try { catalog = await request(); } catch (error) { panel.querySelector('p').textContent = error.message; return; }
  if (!panel.isConnected) return;
  panel.innerHTML = `<div class="speech-heading"><div><h2>语音</h2><p class="settings-note">默认引擎、音色和阅读偏好自动保存，对话朗读也会使用。</p></div><span class="speech-save-state" role="status" data-speech="status"></span></div>
    <div class="speech-engine-list" data-speech="engines"></div>
    <div class="speech-preferences">
      <label class="admin-field"><span>阅读方式</span><select data-speech="textMode" aria-label="阅读方式"><option value="readable">整理为自然阅读稿</option><option value="verbatim">按原文朗读</option></select><small class="settings-note">自然阅读稿会整理表格、数字和符号。</small></label>
      <label class="admin-field"><span>语速</span><select data-speech="speed" aria-label="语速"><option value="0.5">0.5× · 很慢</option><option value="0.75">0.75× · 舒缓</option><option value="1">1× · 自然</option><option value="1.25">1.25× · 稍快</option><option value="1.5">1.5× · 快速</option><option value="1.75">1.75×</option><option value="2">2×</option></select></label>
    </div>
    <div data-speech="breeze" class="speech-custom" hidden>
      <button class="speech-custom-toggle" type="button" aria-expanded="false" data-speech="expand"><span>定制 Breeze 音色</span><span aria-hidden="true">＋</span></button>
      <div data-speech="studio" class="speech-studio" hidden>
        <div class="speech-methods" role="group" aria-label="定制方式"><button type="button" data-method="describe" aria-pressed="true">文字描述</button><button type="button" data-method="record" aria-pressed="false">录音克隆</button><button type="button" data-method="upload" aria-pressed="false">上传声音</button></div>
        <label class="admin-field"><span>音色名称</span><input data-speech="name" maxlength="80" placeholder="例如：温柔晚安"></label>
        <label class="admin-field" data-speech="descriptionField"><span>描述你想要的声音</span><textarea data-speech="description" maxlength="2000" placeholder="例如：温暖轻柔的中文女声，声音自然，适合讲睡前故事。"></textarea></label>
        <div data-speech="reference" hidden>
          <p class="settings-note">使用一段清晰的单人声音，建议 5～15 秒，最长 30 秒。</p>
          <label class="admin-field" data-speech="deviceField" hidden><span>录音麦克风</span><select data-speech="device" aria-label="录音麦克风"><option value="">系统默认麦克风</option></select><small class="settings-note">首次开始录音并授权后显示可用设备。录音中切换麦克风将丢弃当前录音并重新开始。</small></label>
          <div class="speech-reference-actions"><button type="button" class="secondary-button" data-speech="record">开始录音</button><button type="button" class="secondary-button" data-speech="upload">选择音频文件</button><input type="file" hidden data-speech="file" accept="audio/*"><span class="settings-note" data-speech="recordState" role="status"></span></div>
          <audio data-speech="referencePlayer" controls hidden></audio>
          <label class="admin-field"><span>这段声音说了什么</span><textarea data-speech="transcript" maxlength="1000" placeholder="填写与录音一致的文字，帮助音色克隆更准确。"></textarea></label>
        </div>
        <div class="speech-create-actions"><button type="button" class="primary-button" data-speech="create">生成音色</button><div data-speech="result" class="speech-created" hidden><span data-speech="previewLabel">未保存的预览</span><span data-speech="preview"></span><button type="button" class="secondary-button" data-speech="savePreview" data-unavailable="true" disabled>保存音色</button><button type="button" class="text-button" data-speech="discardPreview">放弃</button></div></div>
        <p class="settings-note" role="status" data-speech="studioStatus"></p>
      </div>
    </div>`;
  const el = key => panel.querySelector(`[data-speech="${key}"]`);
  let busy = false, method = 'describe', sample, sampleUrl, previewDraft, attemptId;
  const message = text => { el('status').textContent = text; };
  const defaultEngine = () => catalog.defaults.engine !== 'auto' ? catalog.defaults.engine
    : catalog.profiles.find(p => `saved:${p.id}` === catalog.defaults.voice)?.options.engine
      || catalog.voices.find(v => v.id === catalog.defaults.voice)?.engine
      || (catalog.engines.find(e => e.id === 'breeze')?.configured ? 'breeze' : catalog.engines.find(e => e.configured)?.id);
  const selectedVoice = engine => catalog.engineVoices?.[engine] ?? (defaultEngine() === engine ? catalog.defaults.voice : '') ?? '';
  const previewOptions = engine => ({ engine, voice: selectedVoice(engine), speed: catalog.defaults.speed,
    language: 'auto', instructions: '', textMode: catalog.defaults.textMode });
  const previewText = engine => {
    const id = selectedVoice(engine), profile = catalog.profiles.find(p => `saved:${p.id}` === id);
    const language = profile?.options.language || catalog.voices.find(v => v.id === id)?.language;
    return language === 'en' ? ENGLISH_SAMPLE : language === 'ja' ? 'こんにちは、ミミです。穏やかなひとときをお過ごしください。' : SAMPLE;
  };
  function updateBusy() {
    panel.querySelectorAll('button, select, input, textarea').forEach(control => {
      control.disabled = busy || control.dataset.unavailable === 'true' || (control === el('create') && recorder.active);
      if (control.tagName === 'SELECT') control.dispatchEvent(new Event('picker-sync'));
    });
  }
  async function mutate(action, value) {
    if (busy) return;
    busy = true; updateBusy(); stopSpeech(); message('保存中…');
    try { catalog = await request(action, value); if (panel.isConnected) { render(); message('已保存'); } return true; }
    catch (error) { message(`未保存：${error.message}`); render(); return false; }
    finally { busy = false; updateBusy(); }
  }
  function render() {
    el('engines').replaceChildren();
    for (const engine of catalog.engines) {
      const row = document.createElement('div'); row.className = 'speech-engine-row'; row.dataset.engine = engine.id;
      const active = engine.id === defaultEngine(); row.classList.toggle('is-default', active);
      const title = document.createElement('div'); title.className = 'speech-engine-title';
      const name = document.createElement('strong'); name.textContent = { breeze: 'Breeze', macos: 'macOS', kokoro: 'Kokoro' }[engine.id];
      const note = document.createElement('small'); note.textContent = !engine.configured ? '未配置' : { breeze: '自然表达 · 支持定制', macos: '系统声音 · 轻快省心', kokoro: '轻量合成 · 多种音色' }[engine.id]; title.append(name, note);
      const field = document.createElement('div'); field.className = 'speech-voice-field';
      const select = document.createElement('select'); select.setAttribute('aria-label', `${name.textContent} 音色`);
      const option = (value, label, disabled = false) => { const item = document.createElement('option'); item.value = value; item.textContent = label; item.disabled = disabled; select.append(item); };
      option('', '引擎默认音色');
      for (const voice of catalog.voices.filter(v => v.engine === engine.id)) option(voice.id, voice.label.replace(/^(macOS|Kokoro|Breeze)\s*/, ''));
      for (const voice of catalog.profiles.filter(v => v.options.engine === engine.id)) option(`saved:${voice.id}`, `${voice.name}${voice.state === 'ready' ? ' · 定制' : ' · 未就绪'}`, voice.state !== 'ready');
      select.value = selectedVoice(engine.id); field.append(select);
      if (select.value.startsWith('saved:')) {
        const id = select.value.slice(6), profile = catalog.profiles.find(p => p.id === id);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button speech-remove';
        remove.title = '删除自定义音色'; remove.setAttribute('aria-label', `删除音色 ${profile?.name || ''}`);
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        remove.onclick = () => {
          if (row.querySelector('.speech-delete-confirm')) return;
          const confirm = document.createElement('div'); confirm.className = 'speech-delete-confirm';
          const note = document.createElement('span'); note.textContent = `删除“${profile?.name || ''}”？${catalog.defaults.voice === select.value ? '当前声音将回到引擎默认音色。' : ''}`;
          const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'secondary-button'; yes.textContent = '确认删除';
          const no = document.createElement('button'); no.type = 'button'; no.className = 'text-button'; no.textContent = '取消';
          no.onclick = () => confirm.remove(); yes.onclick = () => void mutate('voice_remove', id);
          confirm.append(note, yes, no); row.append(confirm); yes.focus();
        };
        field.append(remove);
      }
      select.addEventListener('change', () => void mutate('engine_voice', { engine: engine.id, voice: select.value }));
      const preview = speechButton(() => previewText(engine.id), () => previewOptions(engine.id), { onState: message });
      preview.title = `试听 ${name.textContent}`; preview.setAttribute('aria-label', preview.title); preview.dataset.unavailable = String(!engine.configured);
      const use = document.createElement('button'); use.type = 'button'; use.className = 'speech-default-button'; use.setAttribute('aria-pressed', String(active));
      use.textContent = active ? '默认' : '设为默认'; use.setAttribute('aria-label', active ? `${name.textContent} 已是默认引擎` : `将 ${name.textContent} 设为默认引擎`); use.dataset.unavailable = String(!engine.configured);
      use.onclick = () => { if (!active) void mutate('configure', { ...catalog.defaults, ...previewOptions(engine.id) }); };
      row.append(title, field, preview, use); el('engines').append(row);
    }
    el('textMode').value = catalog.defaults.textMode; el('textMode').dispatchEvent(new Event('picker-sync'));
    const speed = String(catalog.defaults.speed);
    if (![...el('speed').options].some(option => option.value === speed)) {
      const option = document.createElement('option'); option.value = speed; option.textContent = `${speed}×`; el('speed').append(option);
    }
    el('speed').value = speed; el('speed').dispatchEvent(new Event('picker-sync'));
    el('breeze').hidden = defaultEngine() !== 'breeze';
    if (el('breeze').hidden) recorder.cancel();
    enhanceSelects(panel); updateBusy();
  }
  let deviceSignature = '';
  const recorder = createRecorder({ maxMs: 30000,
    changed: state => {
      const select = el('device');
      const signature = JSON.stringify([state.devices, state.deviceId]);
      if (signature !== deviceSignature) {
        deviceSignature = signature;
        select.replaceChildren();
        const add = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); };
        add('', '系统默认麦克风');
        (state.devices || []).filter(device => device.deviceId).forEach((device, i) => add(device.deviceId, device.label || `麦克风 ${i + 1}`));
        select.value = [...select.options].some(option => option.value === state.deviceId) ? state.deviceId : '';
      }
      select.disabled = busy || state.requesting;
      select.dispatchEvent(new Event('picker-sync'));
      el('record').textContent = state.active ? '结束录音' : state.requesting ? '取消等待' : '开始录音';
      el('recordState').textContent = state.active ? `${Math.floor(state.elapsed / 1000)} 秒${state.noSignal ? ' · 未检测到声音' : ' · 正在录音'}` : state.requesting ? '等待麦克风授权…' : '';
      el('create').disabled = busy || state.active || state.requesting;
    },
    complete: (_owner, file) => { void setSample(file); },
    error: error => { el('studioStatus').textContent = error.message; },
  });
  async function setSample(file) {
    if (!file) return;
    clearPreview();
    if (file.size > 16 * 1024 * 1024) { el('studioStatus').textContent = '音频文件不能超过 16 MB'; return; }
    busy = true; updateBusy(); el('studioStatus').textContent = '正在准备声音…';
    let context;
    try {
      context = new AudioContext();
      sample = undefined;
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      if (!panel.isConnected) return;
      sample = voiceSampleWav(buffer);
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
      sampleUrl = URL.createObjectURL(sample); el('referencePlayer').src = sampleUrl; el('referencePlayer').hidden = false;
      el('studioStatus').textContent = `已准备 ${buffer.duration.toFixed(1)} 秒声音，请核对下方文字。`;
    } catch (error) { el('referencePlayer').hidden = true; el('studioStatus').textContent = error.message || '无法读取此音频，请换用 WAV 或 MP3'; }
    finally { await context?.close(); busy = false; updateBusy(); }
  }
  el('device').onchange = () => {
    el('studioStatus').textContent = recorder.active ? '已切换麦克风，重新录音中。' : '';
    void recorder.selectDevice(el('device').value);
  };
  el('record').onclick = () => {
    if (recorder.active) recorder.stop();
    else { el('studioStatus').textContent = ''; void recorder.start('voice-studio', el('device').value); }
  };
  el('upload').onclick = () => el('file').click();
  el('file').onchange = () => { void setSample(el('file').files[0]); el('file').value = ''; };
  el('expand').onclick = () => {
    const opening = el('studio').hidden; el('studio').hidden = !opening;
    el('expand').setAttribute('aria-expanded', String(opening)); el('expand').lastElementChild.textContent = opening ? '−' : '＋';
    if (!opening) recorder.cancel();
  };
  panel.querySelectorAll('[data-method]').forEach(button => { button.onclick = () => {
    recorder.cancel(); stopSpeech(); clearPreview(); method = button.dataset.method;
    panel.querySelectorAll('[data-method]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    el('descriptionField').hidden = method !== 'describe'; el('reference').hidden = method === 'describe';
    el('deviceField').hidden = method !== 'record';
    el('record').hidden = method !== 'record'; el('upload').hidden = method !== 'upload';
    el('create').textContent = method === 'describe' ? '生成音色' : '克隆音色';
    el('transcript').value = method === 'record' ? SAMPLE : '';
    sample = undefined; if (sampleUrl) URL.revokeObjectURL(sampleUrl); el('referencePlayer').removeAttribute('src'); el('referencePlayer').hidden = true;
    el('studioStatus').textContent = method === 'record' ? '按下开始录音，朗读下方文字，也可以先修改。' : ''; el('result').hidden = true;
  }; });
  el('textMode').onchange = () => void mutate('configure', { ...catalog.defaults, textMode: el('textMode').value });
  el('speed').onchange = () => void mutate('configure', { ...catalog.defaults, speed: Number(el('speed').value) });
  function clearPreview() {
    const previous = previewDraft; previewDraft = undefined;
    el('result').hidden = true; stopSpeech();
    if (previous) void request('voice_discard', previous.id).catch(error => { if (panel.isConnected) el('studioStatus').textContent = error.message; });
  }
  for (const key of ['name', 'description', 'transcript']) el(key).addEventListener('input', clearPreview);
  el('discardPreview').onclick = () => { clearPreview(); el('studioStatus').textContent = '预览已放弃，未加入音色列表。'; };
  el('savePreview').onclick = async () => {
    if (busy || !previewDraft || el('savePreview').dataset.unavailable === 'true') return;
    const id = previewDraft.id;
    busy = true; updateBusy(); stopSpeech(); el('studioStatus').textContent = '正在保存音色…';
    try {
      catalog = await request('voice_confirm', id); previewDraft = undefined;
      render(); el('result').hidden = true; el('studioStatus').textContent = '已加入音色列表。需要使用时，可从 Breeze 音色列表选择。';
    } catch (error) { el('studioStatus').textContent = error.message; }
    finally { busy = false; updateBusy(); }
  };
  el('create').onclick = async () => {
    if (busy || recorder.active) return;
    const name = el('name').value.trim(), text = el('transcript').value.trim(), instructions = el('description').value.trim();
    if (!name || (method === 'describe' ? !instructions : !sample || !text)) {
      el('studioStatus').textContent = !name ? '请填写音色名称。' : method === 'describe' ? '请描述想要的声音。' : '请准备声音，并填写与声音一致的文字。';
      (!name ? el('name') : method === 'describe' ? el('description') : !sample ? el(method === 'record' ? 'record' : 'upload') : el('transcript')).focus();
      el('studioStatus').scrollIntoView({ block: 'nearest' });
      return;
    }
    clearPreview();
    busy = true; updateBusy(); stopSpeech(); el('result').hidden = true;
    el('studioStatus').textContent = method === 'describe' ? '正在生成试听预览…' : '正在生成克隆试听预览…';
    const createLabel = el('create').textContent;
    el('create').textContent = method === 'describe' ? '正在生成…' : '正在克隆…';
    el('create').setAttribute('aria-busy', 'true');
    try {
      // Keep the same identity after an interrupted attempt; never silently repeat remote work.
      attemptId ||= `voice-${randomUUID()}`;
      let result;
      if (method === 'describe') result = await request('voice_preview', { id: attemptId, name, text: SAMPLE,
        options: { engine: 'breeze', instructions, voice: '', speed: 1, language: 'auto', textMode: 'verbatim' } });
      else {
        const response = await fetch('/api/media', { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-mimi-web': '1' }, body: sample, signal: controller.signal });
        const media = await response.json(); if (!response.ok) throw new Error(media.error || '上传失败');
        result = await request('voice_clone_preview', { id: attemptId, name, text, mediaId: media.id });
      }
      previewDraft = result; attemptId = undefined;
      el('result').hidden = false; el('preview').replaceChildren();
      el('previewLabel').textContent = `预览：${result.name}（未保存）`;
      el('savePreview').dataset.unavailable = 'true';
      const preview = speechButton('', {}, { url: `/api/speech/preview?id=${encodeURIComponent(result.id)}`, onState: text => {
        el('studioStatus').textContent = text;
        if (text === '正在朗读' && previewDraft?.id === result.id) {
          el('savePreview').dataset.unavailable = 'false'; updateBusy();
        }
      } });
      preview.title = '试听新音色'; preview.setAttribute('aria-label', preview.title); el('preview').append(preview);
      el('studioStatus').textContent = '先试听，满意后点击“保存音色”。当前默认音色不会改变。';

    } catch (error) {
      el('studioStatus').textContent = error.message || '生成未完成，请检查原操作后再试。';
      el('studioStatus').scrollIntoView({ block: 'nearest' });
    } finally {
      busy = false; el('create').textContent = createLabel; el('create').setAttribute('aria-busy', 'false'); updateBusy();
    }
  };
  render();
  const observer = new MutationObserver(() => {
    if (panel.isConnected) return;
    observer.disconnect(); recorder.cancel(); stopSpeech();
    if (previewDraft) void fetch('/api/speech/settings', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-mimi-web': '1' }, body: JSON.stringify({ action: 'voice_discard', value: previewDraft.id }) }).catch(() => {});
    controller.abort(); if (sampleUrl) URL.revokeObjectURL(sampleUrl);
  });
  observer.observe(root, { childList: true, subtree: true });
}
