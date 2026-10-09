/** Presentation blocks only. Neither canonical history nor executable HTML lives here. */
export function messageBlocks(text, images = [], media = []) {
  return [...(images.length ? [{type:'images', images}] : []), {type:'text', text}, ...media.map(ref=>({type:ref.kind==='image'?'images':'media',...(ref.kind==='image'?{images:[ref]}:{ref})}))];
}

export function createMessageBody(blocks, {markdown, imagesMarkup, mediaMarkup}) {
  const body = document.createElement('div');
  body.className = 'message-bubble';
  const renderers = {
    text: block => markdown(block.text),
    images: block => imagesMarkup(block.images),
    media: block => mediaMarkup(block.ref),
  };
  for (const block of blocks) {
    if (!renderers[block.type]) continue;
    const element = document.createElement('div');
    element.className = block.type === 'text' ? 'markdown message-block' : block.type==='images'?'message-images message-block':'message-media message-block';
    element.dataset.block = block.type;
    element.innerHTML = renderers[block.type](block);
    body.append(element);
  }
  return body;
}

/** Observe bubble boundaries, never token changes. Content stays readable without animations. */
export function observeMessageMotion(root, scrollRoot) {
  if (!globalThis.IntersectionObserver || !globalThis.MutationObserver) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const states = new Map();
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = states.get(entry.target);
      if (!state) continue;
      const now = performance.now();
      if (!entry.isIntersecting) {
        if (state.visible) state.leftAt = now;
        state.visible = false;
        continue;
      }
      if (state.visible) continue;
      state.visible = true;
      const first = !state.seen;
      state.seen = true;
      if (reduced.matches || document.hidden || !entry.target.animate || (!first && now - state.leftAt < 250)) continue;
      state.animation?.cancel();
      state.animation = entry.target.animate(first ? [
        {opacity:.65, transform:'translateY(9px) scale(.985)'},
        {opacity:1, transform:'translateY(-1px) scale(1.003)', offset:.72},
        {opacity:1, transform:'none'},
      ] : [
        {opacity:.84, transform:'translateY(4px) scale(.997)'},
        {opacity:1, transform:'none'},
      ], {duration:first ? 300 : 180, easing:'cubic-bezier(.2,.75,.25,1)'});
    }
  }, {root:scrollRoot, threshold:0});
  const bubbles = node => node.nodeType !== 1 ? [] : [
    ...(node.matches('.message-bubble') ? [node] : []), ...node.querySelectorAll('.message-bubble'),
  ];
  const add = node => { for (const bubble of bubbles(node)) if (!states.has(bubble)) {
    states.set(bubble, {seen:false, visible:false, leftAt:0}); visibility.observe(bubble);
  } };
  const changes = new MutationObserver(records => {
    for (const record of records) {
      if (record.target.nodeType === 1 && record.target.closest('.message-block')) continue;
      for (const node of record.removedNodes) for (const bubble of bubbles(node)) if (!root.contains(bubble)) {
        states.get(bubble)?.animation?.cancel(); states.delete(bubble); visibility.unobserve(bubble);
      }
      for (const node of record.addedNodes) add(node);
    }
  });
  changes.observe(root,{childList:true,subtree:true}); add(root);
  reduced.addEventListener('change', () => { if(reduced.matches) for(const state of states.values()) state.animation?.cancel(); });
}
