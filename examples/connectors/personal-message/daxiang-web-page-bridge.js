(() => {
  'use strict';

  const VERSION = '1.0.0';
  const MAX_TEXT = 4_000;
  const MAX_EVENTS = 200;
  const state = {
    observer: null,
    events: [],
    attempts: new Map(),
  };

  function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value;
  }

  function requireString(value, name, maximum = MAX_TEXT) {
    if (typeof value !== 'string' || !value || value.length > maximum) {
      throw new Error(`${name} must be a non-empty string up to ${maximum} characters`);
    }
    return value;
  }

  function requireSid(value) {
    const sid = requireString(value, 'sid', 40);
    if (!/^\d+$/.test(sid)) throw new Error('sid must contain digits only');
    return sid;
  }

  function requireType(value) {
    if (value !== 'chat' && value !== 'groupchat') throw new Error('type must be chat or groupchat');
    return value;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  }

  function selectedSession() {
    const rows = document.querySelectorAll('.comp-session.selected[data-sid]');
    if (rows.length !== 1) return null;
    const row = rows[0];
    const type = row.classList.contains('chat')
      ? 'chat'
      : row.classList.contains('groupchat') ? 'groupchat' : 'unknown';
    return { sid: row.getAttribute('data-sid'), type };
  }

  function directionOf(element) {
    const classes = `${element.className || ''} ${element.parentElement?.className || ''}`.toLowerCase();
    if (/(?:^|\s)(?:me|from-me|self|mine|outgoing|send|right)(?:\s|$)/.test(classes)) return 'outgoing';
    if (/(?:^|\s)(?:you|from-other|incoming|receive|left)(?:\s|$)/.test(classes)) return 'incoming';
    const direction = element.getAttribute('data-direction');
    return direction === 'incoming' || direction === 'outgoing' ? direction : 'unknown';
  }

  function messageRecord(element) {
    const mid = element.getAttribute('data-mid');
    if (!mid) return null;
    const actorId = [
      element.getAttribute('data-sender-id'),
      element.getAttribute('data-userid'),
      element.getAttribute('data-uid'),
    ].find((value) => value && value.length <= 500);
    const time = element.querySelector('time')?.getAttribute('datetime')
      || element.getAttribute('data-time')
      || undefined;
    return {
      mid,
      direction: directionOf(element),
      ...(actorId ? { actorId } : {}),
      text: normalizeText(
        element.querySelector('.message-container')?.innerText
        || element.querySelector('.message-container')?.textContent
        || element.innerText
        || element.textContent,
      ),
      ...(time ? { occurredAt: time } : {}),
      receipt: element.getAttribute('data-receipt'),
    };
  }

  function currentMessages(limit) {
    const records = Array.from(document.querySelectorAll('.bubble-item[data-mid]'))
      .map(messageRecord)
      .filter(Boolean);
    return records.slice(Math.max(0, records.length - limit));
  }

  function pageShape() {
    const sessions = Array.from(document.querySelectorAll('.comp-session[data-sid]'));
    const bubbles = Array.from(document.querySelectorAll('.bubble-item[data-mid]'));
    const inputs = document.querySelectorAll('#textTextarea');
    const buttons = Array.from(document.querySelectorAll('#msgSend button'))
      .filter((button) => normalizeText(button.textContent).replace(/\s+/g, '') === '发送');
    return {
      bridgeMajor: 1,
      origin: window.location.origin,
      sessionTag: sessions[0]?.tagName || null,
      stableSessionCount: sessions.filter((row) => /^\d+$/.test(row.getAttribute('data-sid') || '')).length,
      messageTag: bubbles[0]?.tagName || null,
      stableMessageCount: bubbles.filter((row) => Boolean(row.getAttribute('data-mid'))).length,
      inputCount: inputs.length,
      inputTag: inputs[0]?.tagName || null,
      sendButtonCount: buttons.length,
      sendButtonTag: buttons[0]?.tagName || null,
    };
  }

  function inspect(raw) {
    const input = requireObject(raw, 'input');
    const selfSid = requireSid(input.selfSid);
    const selfRows = document.querySelectorAll(`.comp-session[data-sid="${selfSid}"]`);
    const selfLabelElement = selfRows.length === 1
      ? selfRows[0].querySelector('.session-name, .comp-session-name, .nickname, [data-session-name]')
      : null;
    const shape = pageShape();
    return {
      version: VERSION,
      origin: window.location.origin,
      url: window.location.href,
      selected: selectedSession(),
      pageShape: shape,
      selfRowCount: selfRows.length,
      selfRowLabel: selfRows.length === 1
        ? normalizeText(
            selfRows[0].getAttribute('data-session-name')
            || selfLabelElement?.innerText
            || selfLabelElement?.textContent
            || selfRows[0].getAttribute('title'),
          )
        : null,
      readable: shape.stableSessionCount > 0 && shape.inputCount === 1,
      sendStructureReady: shape.inputCount === 1 && shape.inputTag === 'TEXTAREA'
        && shape.sendButtonCount === 1,
    };
  }

  function pushEvent(event) {
    state.events.push({ observedAt: new Date().toISOString(), ...event });
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  }

  function installObserver() {
    if (state.observer) return { installed: false, reason: 'already_installed' };
    state.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node?.nodeType !== 1) continue;
          const candidates = [
            ...(node.matches('.bubble-item[data-mid]') ? [node] : []),
            ...node.querySelectorAll('.bubble-item[data-mid]'),
          ];
          for (const candidate of candidates) {
            const message = messageRecord(candidate);
            if (message) pushEvent({ kind: 'message', session: selectedSession(), message });
          }
        }
        if (mutation.target?.nodeType === 1) {
          const row = mutation.target.closest('.comp-session[data-sid]');
          if (row) pushEvent({
            kind: 'session_change',
            sid: row.getAttribute('data-sid'),
            unread: row.classList.contains('unread'),
          });
        }
      }
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-receipt'],
    });
    return { installed: true };
  }

  function drain() {
    const events = state.events.slice();
    state.events.length = 0;
    return events;
  }

  function selectConversation(raw) {
    const input = requireObject(raw, 'input');
    const sid = requireSid(input.sid);
    const type = requireType(input.type);
    const rows = document.querySelectorAll(`.comp-session[data-sid="${sid}"].${type}`);
    if (rows.length !== 1) return { selected: false, reason: 'target_not_unique', count: rows.length };
    const current = selectedSession();
    if (current?.sid === sid && current.type === type) {
      return { selected: true, changed: false, requested: { sid, type }, current };
    }
    rows[0].click();
    return { selected: true, changed: true, requested: { sid, type }, current: selectedSession() };
  }

  function readCurrentConversation(raw) {
    const input = requireObject(raw, 'input');
    const sid = requireSid(input.sid);
    const type = requireType(input.type);
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
    const selected = selectedSession();
    const expectedPath = `/chat/${sid}`;
    const routeType = new URLSearchParams(window.location.search).get('type');
    if (
      selected?.sid !== sid
      || selected.type !== type
      || window.location.pathname !== expectedPath
      || routeType !== type
    ) return { matched: false, sid, type, selected, route: `${window.location.pathname}${window.location.search}` };
    return {
      matched: true,
      sid,
      type,
      messages: currentMessages(limit),
      capturedAt: new Date().toISOString(),
      readStateChanged: 'unknown',
    };
  }

  function textarea() {
    const inputs = document.querySelectorAll('#textTextarea');
    if (inputs.length !== 1 || inputs[0].tagName !== 'TEXTAREA') throw new Error('text input must be one textarea');
    return inputs[0];
  }

  function sendButton() {
    const buttons = Array.from(document.querySelectorAll('#msgSend button'))
      .filter((button) => normalizeText(button.textContent).replace(/\s+/g, '') === '发送');
    if (buttons.length !== 1 || buttons[0].disabled) throw new Error('send button must be one enabled button');
    return buttons[0];
  }

  function prepareSend(raw) {
    const input = requireObject(raw, 'input');
    const attemptId = requireString(input.attemptId, 'attemptId', 200);
    const sid = requireSid(input.sid);
    const type = requireType(input.type);
    const text = requireString(input.text, 'text');
    if (state.attempts.has(attemptId)) return { prepared: false, reason: 'attempt_exists' };
    const current = readCurrentConversation({ sid, type, limit: 100 });
    if (!current.matched) return { prepared: false, reason: 'target_not_selected' };
    const inputElement = textarea();
    if (inputElement.value !== '') return { prepared: false, reason: 'existing_draft' };
    const descriptor = Object.getOwnPropertyDescriptor(
      inputElement.ownerDocument.defaultView.HTMLTextAreaElement.prototype,
      'value',
    );
    if (!descriptor?.set) throw new Error('native textarea setter unavailable');
    descriptor.set.call(inputElement, text);
    inputElement.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }));
    if (inputElement.value !== text) return { prepared: false, reason: 'text_verification_failed' };
    sendButton();
    state.attempts.set(attemptId, {
      sid,
      type,
      text,
      beforeMids: new Set(current.messages.map((message) => message.mid)),
      committed: false,
      committedAt: null,
    });
    return { prepared: true, attemptId, sid, type };
  }

  function commitSend(raw) {
    const input = requireObject(raw, 'input');
    const attemptId = requireString(input.attemptId, 'attemptId', 200);
    const attempt = state.attempts.get(attemptId);
    if (!attempt) return { dispatched: false, reason: 'attempt_not_found' };
    if (attempt.committed) return { dispatched: true, repeated: true, committedAt: attempt.committedAt };
    const current = readCurrentConversation({ sid: attempt.sid, type: attempt.type, limit: 1 });
    if (!current.matched || textarea().value !== attempt.text) {
      return { dispatched: false, reason: 'precommit_verification_failed' };
    }
    const button = sendButton();
    attempt.committed = true;
    attempt.committedAt = new Date().toISOString();
    button.click();
    return { dispatched: true, repeated: false, committedAt: attempt.committedAt };
  }

  function observeSend(raw) {
    const input = requireObject(raw, 'input');
    const attemptId = requireString(input.attemptId, 'attemptId', 200);
    const attempt = state.attempts.get(attemptId);
    if (!attempt) return { status: 'failed', reason: 'attempt_not_found' };
    if (!attempt.committed) return { status: 'failed', reason: 'not_committed' };
    const candidates = currentMessages(100).filter((message) => (
      !attempt.beforeMids.has(message.mid) && message.text.includes(attempt.text)
    ));
    if (candidates.length === 1) {
      return { status: 'observed', message: { ...candidates[0], direction: 'outgoing' }, draftEmpty: textarea().value === '' };
    }
    if (candidates.length > 1) return { status: 'uncertain', reason: 'multiple_candidates' };
    const failed = Array.from(document.querySelectorAll('.bubble-item')).find((element) => {
      const text = normalizeText(
        element.querySelector('.message-container')?.innerText
        || element.querySelector('.message-container')?.textContent
        || element.innerText
        || element.textContent,
      );
      if (!text.includes(attempt.text)) return false;
      const receipt = element.getAttribute('data-receipt');
      return element.matches('[class*="fail"], [class*="error"], [class*="retry"]')
        || Boolean(element.querySelector(
          '[class*="fail"], [class*="error"], [class*="retry"], [class*="resend"]',
        ))
        || (receipt !== null && receipt !== '' && receipt !== '0');
    });
    if (failed) return { status: 'failed', reason: 'page_marked_send_failed' };
    return { status: 'pending' };
  }

  function dispose() {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    state.events.length = 0;
    state.attempts.clear();
    return { disposed: true };
  }

  Object.defineProperty(window, '__mimiDaxiangBridge', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      version: VERSION,
      inspect,
      installObserver,
      drain,
      selectConversation,
      readCurrentConversation,
      prepareSend,
      commitSend,
      observeSend,
      dispose,
    }),
  });
})();
