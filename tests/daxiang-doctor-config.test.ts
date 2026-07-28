import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countMissingDaxiangOwnerBindings } from '../src/daemon/service.js';

const fingerprint = `sha256:${'a'.repeat(64)}`;

test('Daxiang Doctor detects missing and stale owner bindings', () => {
  const binding = {
    selectedBy: 'owner',
    accountFingerprint: fingerprint,
    authorizationRevision: 'owner-revision-1',
  };
  const config = {
    expectedAccountFingerprint: fingerprint,
    selfConversation: { sid: '1', type: 'chat', binding },
    watch: {
      conversations: [
        { sid: '2', type: 'chat' },
        {
          sid: '3',
          type: 'groupchat',
          binding: { ...binding, accountFingerprint: `sha256:${'b'.repeat(64)}` },
        },
        { sid: '4', type: 'chat', binding },
      ],
    },
  };

  assert.equal(countMissingDaxiangOwnerBindings(config), 2);
  assert.equal(countMissingDaxiangOwnerBindings({
    ...config,
    watch: {
      conversations: config.watch.conversations.map((target) => ({ ...target, binding })),
    },
  }), 0);
});
