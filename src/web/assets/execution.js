/** Project the public stream without joining replies across tool/thinking phases. */
export function projectEvent(run, event) {
  if (event.sequence <= run.sequence) return false;
  run.sequence = event.sequence;
  if (event.kind === 'answer') {
    if (run.boundary || !run.answers.length) run.answers.push('');
    run.answers[run.answers.length - 1] += event.text;
    run.boundary = false;
  } else {
    run.boundary = true;
    const last = run.steps.at(-1);
    if (event.kind === 'reasoning' && last?.kind === 'reasoning') last.text += event.text;
    else run.steps.push({ ...event });
  }
  return true;
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

/** Frame-paced presentation only. Authoritative text stays in the run cache. */
export function createTextReveal(initial = []) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let parts = initial.map(text => ({ text, units: [...segmenter.segment(text)].map(x => x.segment), count: [...segmenter.segment(text)].length }));
  let previous = 0, deadline = 0;
  return {
    update(texts, now, immediate = false) {
      const wasPending = parts.some(p => p.count < p.units.length);
      const changed = texts.length !== parts.length || texts.some((text, i) => text !== parts[i]?.text);
      parts = texts.map((text, index) => {
        const old = parts[index];
        if (old?.text === text) return old;
        const units = [...segmenter.segment(text)].map(x => x.segment);
        return { text, units, count: old && text.startsWith(old.text) ? Math.min(old.count, units.length) : 0 };
      });
      if (changed) deadline = now + 700;
      if (!wasPending) previous = now - 16;
      if (immediate || now >= deadline) for (const part of parts) part.count = part.units.length;
      else {
        const pending = parts.reduce((n, p) => n + p.units.length - p.count, 0);
        const dt = Math.max(0, Math.min(50, now - previous));
        let budget = Math.max(1, Math.ceil(Math.max(45, pending / Math.max(.05, (deadline-now)/1000)) * dt/1000));
        for (const part of parts) { const count = Math.min(budget, part.units.length-part.count); part.count += count; budget -= count; }
      }
      previous = now;
      return parts.map(p => p.units.slice(0,p.count).join(''));
    },
    get pending() { return parts.some(p => p.count < p.units.length); },
  };
}
