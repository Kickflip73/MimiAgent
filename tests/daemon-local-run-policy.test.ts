import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRequestedSecurityProfile,
  requestedSecurityProfileForLocalSubmit,
  requestedSecurityProfileForEvent,
} from '../src/daemon/local-run-policy.js';

test('requested security parser is exact and fail-closed', () => {
  assert.equal(parseRequestedSecurityProfile('safe'), 'safe');
  assert.equal(parseRequestedSecurityProfile('workstation'), 'workstation');
  assert.equal(parseRequestedSecurityProfile('full-owner'), 'full-owner');
  assert.equal(parseRequestedSecurityProfile(undefined), undefined);
  assert.throws(() => parseRequestedSecurityProfile('owner'), /不支持/u);
});

test('local submit security metadata is authenticated, Session-bound, and reserved', () => {
  const accepted = {
    source: 'local-cli',
    trust: 'owner' as const,
    sessionKey: 'owner-session',
    payload: undefined,
    requestedSecurityProfile: 'workstation',
  };
  assert.equal(requestedSecurityProfileForLocalSubmit(accepted), 'workstation');
  assert.throws(() => requestedSecurityProfileForLocalSubmit({
    ...accepted,
    payload: { requestedSecurityProfile: 'safe' },
  }), /保留字段/u);
  assert.throws(() => requestedSecurityProfileForLocalSubmit({
    ...accepted,
    source: 'connector:test',
    trust: 'external',
  }), /仅允许认证 local-cli owner/u);
  assert.throws(() => requestedSecurityProfileForLocalSubmit({
    ...accepted,
    sessionKey: undefined,
  }), /显式 Session/u);
  assert.throws(() => requestedSecurityProfileForLocalSubmit({
    ...accepted,
    payload: 'non-object',
  }), /非对象 payload/u);
});

test('only authenticated local-owner Event metadata can request a security ceiling', () => {
  const payload = { requestedSecurityProfile: 'safe' };
  assert.equal(requestedSecurityProfileForEvent({
    source: 'local-cli',
    trust: 'owner',
    payload,
  }), 'safe');
  assert.equal(requestedSecurityProfileForEvent({
    source: 'connector:test',
    trust: 'external',
    payload,
  }), undefined);
});
