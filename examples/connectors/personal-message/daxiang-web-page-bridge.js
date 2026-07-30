(() => {
  'use strict';

  const VERSION = '1.1.0';
  const MAX_TEXT = 4_000;
  const MAX_EVENTS = 200;
  const SESSION_TYPES = Object.freeze(['chat', 'groupchat', 'pubchat', 'collectchat']);
  const state = {
    observer: null,
    events: [],
    attempts: new Map(),
    search: null,
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
    if (!SESSION_TYPES.includes(value)) {
      throw new Error(`type must be one of ${SESSION_TYPES.join(', ')}`);
    }
    return value;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  }

  function sessionType(row) {
    return SESSION_TYPES.find((type) => row.classList.contains(type)) || null;
  }

  function sessionRecord(row) {
    const sid = row.getAttribute('data-sid');
    const type = sessionType(row);
    if (!sid || !/^\d+$/.test(sid) || !type) return null;
    const labelElement = row.querySelector(
      '.session-name, .comp-session-name, .nickname, [data-session-name]',
    );
    const label = normalizeText(
      row.getAttribute('data-session-name')
      || labelElement?.innerText
      || labelElement?.textContent
      || row.getAttribute('title'),
    );
    return {
      sid,
      type,
      ...(label ? { label: label.slice(0, 200) } : {}),
      unread: row.classList.contains('unread'),
      selected: row.classList.contains('selected'),
    };
  }

  function candidateType(element) {
    const rowType = sessionType(element);
    if (rowType) return rowType;
    const className = String(element.className || '');
    if (/(?:^|\s)user(?:\s|$)/.test(className)) return 'chat';
    if (/(?:^|\s)group(?:\s|$)/.test(className)) return 'groupchat';
    const declared = [
      element.getAttribute('data-type'),
      element.getAttribute('data-session-type'),
      element.closest('[data-type]')?.getAttribute('data-type'),
      element.closest('[data-session-type]')?.getAttribute('data-session-type'),
    ].find((value) => SESSION_TYPES.includes(value));
    if (declared) return declared;
    const href = element.closest('a[href]')?.getAttribute('href')
      || element.querySelector('a[href]')?.getAttribute('href');
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      const routeType = url.searchParams.get('type');
      return SESSION_TYPES.includes(routeType) ? routeType : null;
    } catch {
      return null;
    }
  }

  function candidateOwner(element) {
    return element.closest('.suggest-item')
      || element.closest('[data-sid], [data-uid], [uid]')
      || element;
  }

  function candidateId(element) {
    return element.getAttribute('data-sid')
      || element.getAttribute('data-uid')
      || element.getAttribute('uid')
      || element.querySelector('[data-sid]')?.getAttribute('data-sid')
      || element.querySelector('[data-uid]')?.getAttribute('data-uid')
      || element.querySelector('[uid]')?.getAttribute('uid');
  }

  function isVisible(element) {
    return element.getClientRects().length > 0
      && window.getComputedStyle(element).visibility !== 'hidden';
  }

  function isSearchSurface(element) {
    if (element.matches('.comp-session[data-sid]')) return true;
    let current = element;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      if (/search/i.test(String(current.className || ''))) return true;
    }
    return false;
  }

  function candidateRecord(element) {
    const owner = candidateOwner(element);
    const sid = candidateId(owner);
    const declaredType = candidateType(owner);
    const type = declaredType || (
      isSearchSurface(owner)
      && Boolean(
        owner.hasAttribute('data-uid')
        || owner.hasAttribute('uid')
        || owner.querySelector('[data-uid], [uid]'),
      )
        ? 'chat'
        : null
    );
    if (!isVisible(owner) || !isSearchSurface(owner)
      || !sid || !/^\d+$/.test(sid) || !type) return null;
    const labelElement = owner.querySelector(
      '.session-name, .comp-session-name, .nickname, [data-session-name], [data-name]',
    );
    const label = normalizeText(
      owner.getAttribute('data-session-name')
      || owner.getAttribute('data-name')
      || labelElement?.innerText
      || labelElement?.textContent
      || owner.getAttribute('title')
      || owner.innerText
      || owner.textContent,
    );
    if (!label) return null;
    return { sid, type, label: label.slice(0, 200) };
  }

  function searchInput() {
    const inputs = document.querySelectorAll('#navSearchInput');
    if (inputs.length !== 1 || inputs[0].tagName !== 'INPUT') {
      throw new Error('Daxiang target search input must be one input');
    }
    return inputs[0];
  }

  function setInputValue(element, value) {
    const previousValue = String(element.value || '');
    const descriptor = Object.getOwnPropertyDescriptor(
      element.ownerDocument.defaultView.HTMLInputElement.prototype,
      'value',
    );
    if (!descriptor?.set) throw new Error('native input setter unavailable');
    descriptor.set.call(element, value);
    if (element._valueTracker?.setValue) {
      element._valueTracker.setValue(previousValue);
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: value ? 'insertText' : 'deleteContentBackward',
      data: value || null,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function beginTargetSearch(raw) {
    const input = requireObject(raw, 'input');
    const query = requireString(input.query, 'query', 100).trim();
    const element = searchInput();
    state.search = {
      query,
      previousValue: String(element.value || ''),
    };
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: query.at(-1) || '',
    }));
    setInputValue(element, query);
    element.dispatchEvent(new KeyboardEvent('keyup', {
      bubbles: true,
      key: query.at(-1) || '',
    }));
    return { started: true, queryLength: query.length };
  }

  function targetSearchCandidates(raw) {
    const input = requireObject(raw, 'input');
    const query = requireString(input.query, 'query', 100).trim();
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('limit must be 1..20');
    }
    if (!state.search || state.search.query !== query || searchInput().value !== query) {
      return { matched: false, reason: 'search_state_changed', candidates: [] };
    }
    const normalizedQuery = query.toLocaleLowerCase();
    const seen = new Set();
    const candidates = Array.from(document.querySelectorAll('[data-sid], [data-uid], [uid]'))
      .map(candidateRecord)
      .filter(Boolean)
      .filter((candidate) => candidate.label.toLocaleLowerCase().includes(normalizedQuery))
      .filter((candidate) => {
        const key = `${candidate.type}:${candidate.sid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
    return { matched: true, candidates };
  }

  function finishTargetSearch() {
    if (!state.search) return { restored: false, reason: 'search_not_started' };
    const previousValue = state.search.previousValue;
    state.search = null;
    const element = searchInput();
    setInputValue(element, previousValue);
    return { restored: true };
  }

  function activateTargetSearchCandidate(raw) {
    const input = requireObject(raw, 'input');
    const query = requireString(input.query, 'query', 100).trim();
    const sid = requireSid(input.sid);
    const type = requireType(input.type);
    if (!state.search || state.search.query !== query || searchInput().value !== query) {
      return { activated: false, reason: 'search_state_changed' };
    }
    const normalizedQuery = query.toLocaleLowerCase();
    const selector = [
      `[data-sid="${sid}"]`,
      `[data-uid="${sid}"]`,
      `[uid="${sid}"]`,
    ].join(', ');
    const matches = Array.from(document.querySelectorAll(selector))
      .map(candidateOwner)
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter((element) => {
        const candidate = candidateRecord(element);
        return candidate?.sid === sid
          && candidate.type === type
          && candidate.label.toLocaleLowerCase().includes(normalizedQuery);
      });
    const sessionMatches = matches.filter((element) => element.matches('.comp-session[data-sid]'));
    const exact = sessionMatches.length === 1 ? sessionMatches : matches;
    if (exact.length !== 1) {
      return {
        activated: false,
        reason: exact.length > 1 ? 'target_ambiguous' : 'target_missing',
        count: exact.length,
      };
    }
    state.search = null;
    exact[0].click();
    return { activated: true, sid, type };
  }

  function selectedSession() {
    const rows = document.querySelectorAll('.comp-session.selected[data-sid]');
    if (rows.length !== 1) return null;
    const record = sessionRecord(rows[0]);
    return record ? { sid: record.sid, type: record.type } : null;
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
    const identityLabels = Array.from(document.querySelectorAll(`[uid="${selfSid}"]`))
      .map((element) => normalizeText(element.closest('[data-title]')?.getAttribute('data-title')))
      .filter(Boolean);
    const uniqueIdentityLabels = [...new Set(identityLabels)];
    const rowLabel = selfRows.length === 1
      ? normalizeText(
          selfRows[0].getAttribute('data-session-name')
          || selfLabelElement?.innerText
          || selfLabelElement?.textContent
          || selfRows[0].getAttribute('title'),
        )
      : null;
    const identityCandidates = [...new Set(
      [rowLabel, ...uniqueIdentityLabels].filter(Boolean),
    )];
    const identityAmbiguous = selfRows.length > 1 || identityCandidates.length > 1;
    const identityLabel = !identityAmbiguous && identityCandidates.length === 1
      ? identityCandidates[0]
      : null;
    const shape = pageShape();
    return {
      version: VERSION,
      origin: window.location.origin,
      url: window.location.href,
      selected: selectedSession(),
      pageShape: shape,
      selfRowCount: selfRows.length,
      selfRowLabel: rowLabel,
      selfIdentityLabel: identityLabel,
      selfIdentityUnique: Boolean(identityLabel) && !identityAmbiguous,
      selfIdentityAmbiguous: identityAmbiguous,
      readable: shape.stableSessionCount > 0,
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

  function targetCandidate(raw) {
    const input = requireObject(raw, 'input');
    const sid = requireSid(input.sid);
    const type = input.type === undefined ? undefined : requireType(input.type);
    const candidates = Array.from(document.querySelectorAll(`.comp-session[data-sid="${sid}"]`))
      .map(sessionRecord)
      .filter(Boolean)
      .filter((candidate) => !type || candidate.type === type);
    return {
      matched: candidates.length === 1,
      sid,
      ...(type ? { type } : {}),
      ...(candidates.length === 1 ? { candidate: candidates[0] } : {}),
      count: candidates.length,
    };
  }

  function listSessions(raw) {
    const input = requireObject(raw, 'input');
    const offset = Number(input.offset);
    const limit = Number(input.limit);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
      throw new Error('offset must be 0..10000');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be 1..100');
    }
    const seen = new Set();
    const sessions = Array.from(document.querySelectorAll('.comp-session[data-sid]'))
      .map(sessionRecord)
      .filter(Boolean)
      .filter((session) => {
        const key = `${session.type}:${session.sid}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      offset,
      limit,
      loadedCount: sessions.length,
      sessions: sessions.slice(offset, offset + limit),
    };
  }

  function sessionScrollState() {
    const containers = document.querySelectorAll('.comp-dynamic-loader.main-list');
    if (containers.length !== 1) {
      return { available: false, count: containers.length };
    }
    const container = containers[0];
    return {
      available: true,
      top: container.scrollTop,
      height: container.scrollHeight,
      viewport: container.clientHeight,
    };
  }

  function loadMoreSessions() {
    const containers = document.querySelectorAll('.comp-dynamic-loader.main-list');
    if (containers.length !== 1) {
      return { requested: false, reason: 'session_list_not_unique', count: containers.length };
    }
    const container = containers[0];
    const before = {
      top: container.scrollTop,
      height: container.scrollHeight,
    };
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      requested: true,
      before,
      afterTop: container.scrollTop,
    };
  }

  function restoreSessionScroll(raw) {
    const input = requireObject(raw, 'input');
    const top = Number(input.top);
    if (!Number.isFinite(top) || top < 0) throw new Error('top must be a non-negative number');
    const containers = document.querySelectorAll('.comp-dynamic-loader.main-list');
    if (containers.length !== 1) {
      return { restored: false, reason: 'session_list_not_unique', count: containers.length };
    }
    containers[0].scrollTop = top;
    containers[0].dispatchEvent(new Event('scroll', { bubbles: true }));
    return { restored: true, top: containers[0].scrollTop };
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
    state.search = null;
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
      targetCandidate,
      listSessions,
      sessionScrollState,
      loadMoreSessions,
      restoreSessionScroll,
      beginTargetSearch,
      targetSearchCandidates,
      finishTargetSearch,
      activateTargetSearchCandidate,
      selectConversation,
      readCurrentConversation,
      prepareSend,
      commitSend,
      observeSend,
      dispose,
    }),
  });
})();
