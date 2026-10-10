// Older daemons/caches did not mark preparation notices. Match only empty host
// notices, never model reasoning or tool evidence with the same wording.
const legacyPreparationTitles = new Set(['正在准备附件与运行环境','正在准备回答','正在理解图片与视频画面','正在准备上下文','正在等待模型响应']);
export function isPreparationStatus(step) {
  return step.kind === 'status' && (step.transient === true ||
    (step.tone === 'thinking' && !step.detail && !step.fullDetail && !step.next && legacyPreparationTitles.has(step.title)));
}

/** Project the public stream without joining replies across tool/thinking phases. */
export function projectEvent(run, event) {
  if (event.sequence <= run.sequence) return false;
  run.sequence = event.sequence;
  if (isPreparationStatus(event)) { run.activity = event.title; return true; }
  run.activity = undefined;
  if (event.kind === 'answer') {
    if (run.boundary || !run.answers.length) run.answers.push('');
    run.answers[run.answers.length - 1] += event.text;
    run.boundary = false;
  } else {
    run.boundary = true;
    const afterAnswer = run.answers.length - 1;
    const last = run.steps.at(-1);
    if (event.kind === 'reasoning' && last?.kind === 'reasoning' && last.afterAnswer === afterAnswer) last.text += event.text;
    else run.steps.push({ ...event, afterAnswer });
  }
  return true;
}
/** Stable positions relative to replies; legacy caches keep their original leading group. */
export function executionGroups(run) {
  const groups = new Map();
  for (const step of run.steps || []) {
    if (isPreparationStatus(step)) continue;
    const afterAnswer = Number.isInteger(step.afterAnswer) ? step.afterAnswer : -1;
    if (!groups.has(afterAnswer)) groups.set(afterAnswer, {afterAnswer, steps:[]});
    groups.get(afterAnswer).steps.push(step);
  }
  return [...groups.values()].sort((a,b)=>a.afterAnswer-b.afterAnswer);
}
export function finishAnswers(answers, finalText, boundary = false) {
  if (!finalText) return answers;
  if (answers.at(-1)?.trim() === finalText.trim()) return answers;
  // A durable answer replaces the final partial reply, never earlier commentary.
  return [...(boundary ? answers : answers.slice(0, -1)), finalText];
}
export function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Saved Session tool units remain available after the daemon's live buffer is evicted. */
export function historyExecution(items) {
  const steps=[], calls=new Map();
  const text=value=>typeof value==='string'?value:JSON.stringify(value,null,2);
  for(const item of items || []) {
    if(item.type==='function_call') {
      const step={kind:'status',tone:'tool',title:item.name||'工具调用',fullDetail:`参数\n${text(item.arguments)}`,next:''};
      steps.push(step);calls.set(item.callId||item.call_id,step);
    } else if(item.type==='function_call_result' || item.type==='function_call_output') {
      const step=calls.get(item.callId||item.call_id);
      if(step)step.fullDetail+=`\n\n结果\n${text(item.output)}`;
      else steps.push({kind:'status',tone:'tool',title:item.name||'工具结果',fullDetail:text(item.output),next:''});
    } else if(item.type==='reasoning') {
      const content=(item.summary||item.content||[]);
      const reasoning=typeof content==='string'?content:content.map(part=>part.text||'').join('\n');
      if(reasoning)steps.push({kind:'reasoning',text:reasoning});
    }
  }
  return steps;
}

/** Separate the legacy Host envelope from user-facing prose, without changing stored evidence. */
export function presentAnswer(value) {
  const text = String(value ?? '');
  const header = /^Host 终态：outcome=(partial|blocked|interrupted|failed|uncertain)；本轮不构成整体完成声明。(?:\r?\n|$)/u.exec(text);
  if (!header) return { text };
  const marker = '模型草稿（仅作未验证的执行摘要）：\n';
  const normalized = text.replace(/\r\n/g, '\n');
  const at = normalized.indexOf(marker, header[0].trimEnd().length);
  const prefix = normalized.slice(header[0].trimEnd().length, at < 0 ? undefined : at).trim();
  // Do not strip quoted or lookalike model/user prose. Only recognize the generated envelope.
  if (prefix && !prefix.split(/\n\n/).every(line => /^(原因|下一步|证据引用)：/u.test(line))) return { text };
  const fallback = {partial:'本次仅完成部分工作。',blocked:'需要补充信息后才能继续。',interrupted:'本次执行已停止。',failed:'本次执行未完成。',uncertain:'执行结果尚未确认。'};
  return { text: at < 0 ? fallback[header[1]] : normalized.slice(at + marker.length), outcome: header[1] };
}

/** Frame-paced presentation only. Authoritative text stays in the run cache. */
export function createTextReveal(initial = []) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const unitsOf = text => [...segmenter.segment(text)].map(x => x.segment);
  let parts = initial.map(text => { const units = unitsOf(text); return { text, units, count: units.length }; });
  let previous = 0, deadline = 0, rate = 60, credit = 0;
  return {
    update(texts, now, immediate = false) {
      const wasPending = parts.some(p => p.count < p.units.length);
      const changed = texts.length !== parts.length || texts.some((text, i) => text !== parts[i]?.text);
      parts = texts.map((text, index) => {
        const old = parts[index];
        if (old?.text === text) return old;
        const units = unitsOf(text);
        return { text, units, count: old && text.startsWith(old.text) ? Math.min(old.count, units.length) : 0 };
      });
      // A small reservoir smooths network bursts; a hard bound prevents a typing queue.
      if (changed) deadline = now + 350;
      if (!wasPending) { previous = now - 16; credit = 0; }
      if (immediate || now >= deadline) { for (const part of parts) part.count = part.units.length; credit = 0; }
      else {
        const pending = parts.reduce((n, p) => n + p.units.length - p.count, 0);
        const dt = Math.max(0, Math.min(50, now - previous));
        const target = Math.max(60, pending / .22);
        rate += (target - rate) * (1 - Math.exp(-dt / 100));
        rate = Math.max(rate, pending / .35);
        credit += rate * dt / 1000;
        let budget = Math.min(pending, Math.floor(credit));
        credit -= budget;
        if (!wasPending && pending && !budget) { budget = 1; credit = 0; }
        for (const part of parts) { const count = Math.min(budget, part.units.length-part.count); part.count += count; budget -= count; }
      }
      previous = now;
      return parts.map(p => p.units.slice(0,p.count).join(''));
    },
    get pending() { return parts.some(p => p.count < p.units.length); },
  };
}

/** Keep the birth time of new visible text across Markdown rerenders. */
export function createTextFade() {
  let previous = '', ranges = [];
  return (text, now, immediate = false) => {
    let common = 0;
    while (common < previous.length && common < text.length && previous[common] === text[common]) common++;
    ranges = immediate ? [] : ranges.filter(r => now - r.born < 160 && r.start < common)
      .map(r => ({...r, end: Math.min(r.end, common)}));
    if (!immediate && common < text.length) ranges.push({ start: common, end: text.length, born: now });
    previous = text;
    return ranges;
  };
}

/** Animate only newly visible text, preserving Markdown structure and link/code semantics. */
export function renderStreamText(container, html, now, immediate = false) {
  const doc = container.ownerDocument;
  const body = doc.createElement('div');
  body.innerHTML = html;
  const ranges = (container._textFade ||= createTextFade())(body.textContent, now, immediate);
  if (ranges.length) {
    const walker = doc.createTreeWalker(body, 4); // SHOW_TEXT
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let offset = 0;
    for (const node of nodes) {
      const text = node.textContent, end = offset + text.length;
      const overlaps = ranges.filter(r => r.start < end && r.end > offset);
      if (overlaps.length) {
        const fragment = doc.createDocumentFragment();
        let cursor = 0;
        for (const range of overlaps) {
          const start = Math.max(0, range.start - offset), stop = Math.min(text.length, range.end - offset);
          fragment.append(doc.createTextNode(text.slice(cursor, start)));
          const span = doc.createElement('span');
          span.className = 'stream-ink';
          span.style.animationDelay = `${-Math.max(0, now - range.born)}ms`;
          span.textContent = text.slice(start, stop);
          fragment.append(span); cursor = stop;
        }
        fragment.append(doc.createTextNode(text.slice(cursor))); node.replaceWith(fragment);
      }
      offset = end;
    }
  }
  container.replaceChildren(...body.childNodes);
}

/** Closed summary only: keep the current step's beginning stable as more text arrives. */
export function runningActivity(steps, fallback = '正在准备回答') {
  const step = steps?.at(-1);
  if (!step) return fallback;
  const prefix = value => {
    const chars = Array.from(String(value).replace(/\s+/g, ' ').trim());
    return chars.length > 220 ? `${chars.slice(0, 220).join('')}…` : chars.join('');
  };
  if (step.kind === 'reasoning') return prefix(`思考 ${step.text || ''}`);
  let detail = step.fullDetail || step.detail || '';
  try {
    const args = JSON.parse(detail);
    detail = args?.path || args?.file_path || args?.command || args?.query || detail;
  } catch { /* Plain text keeps its original beginning as well. */ }
  return prefix(`${step.title || step.next || fallback}${detail ? ' ' + detail : ''}`);
}
