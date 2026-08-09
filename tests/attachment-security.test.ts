import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentPayload,
  inputWithAttachments,
  validateLocalAttachmentSubmission,
  type StagedAttachment,
} from '../src/runtime/attachments.js';
import {
  mediaEvidenceIdsFromPayload,
  parseMediaReferenceInput,
} from '../src/runtime/media-reference-request.js';

const digest = 'a'.repeat(64);

function durableFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'file',
    name: 'notes.txt',
    mediaType: 'text/plain',
    bytes: 1,
    sha256: digest,
    artifactRef: `media-artifact:sha256:${digest}`,
    ...overrides,
  };
}

test('durable attachments reject private names, malformed MIME, and unknown path fields', () => {
  for (const name of ['/Users/owner/private.txt', 'C:\\Users\\owner\\private.txt', 'x\r\nheader']) {
    assert.throws(() => attachmentPayload({ attachments: [durableFile({ name })] }), /元数据无效/u);
  }
  assert.throws(
    () => attachmentPayload({ attachments: [durableFile({ mediaType: 'text/plain\r\nx-leak: yes' })] }),
    /元数据无效/u,
  );
  assert.throws(
    () => attachmentPayload({ attachments: [durableFile({ mediaType: 'AUDIO/WAV' })] }),
    /元数据无效/u,
  );
  assert.throws(
    () => attachmentPayload({ attachments: [durableFile({ path: '/Users/owner/private.txt' })] }),
    /元数据无效/u,
  );
  assert.throws(
    () => attachmentPayload({ attachments: [durableFile({ legacyPath: '/Users/owner/private.txt' })] }),
    /元数据无效/u,
  );
});

test('legacy adapter is explicit and still validates canonical metadata', () => {
  const legacy = {
    kind: 'file',
    name: 'notes.txt',
    mediaType: 'text/plain',
    bytes: 1,
    sha256: digest,
    path: `/isolated/attachments/${digest}`,
  };
  assert.throws(() => attachmentPayload({ attachments: [legacy] }), /元数据无效/u);
  assert.equal(attachmentPayload({ attachments: [legacy] }, { allowLegacyPath: true }).length, 1);
  assert.throws(
    () => attachmentPayload({ attachments: [{ ...legacy, name: '/Users/owner/notes.txt' }] }, {
      allowLegacyPath: true,
    }),
    /元数据无效/u,
  );
});

test('durable and provider boundaries reject more than eight attachments before reads', async () => {
  const nine = Array.from({ length: 9 }, () => durableFile());
  assert.throws(() => attachmentPayload({ attachments: nine }), /最多 8 个/u);

  const staged = nine as unknown as StagedAttachment[];
  await assert.rejects(inputWithAttachments('inspect', staged, '/unreachable'), /最多 8 个/u);

  const legacyNine = nine.map((item) => {
    const { artifactRef: _artifactRef, ...rest } = item;
    return { ...rest, path: `/isolated/attachments/${digest}` };
  });
  assert.throws(
    () => attachmentPayload({ attachments: legacyNine }, { allowLegacyPath: true }),
    /最多 8 个/u,
  );
});

test('durable payload rejects a present non-array attachments field', () => {
  assert.deepEqual(attachmentPayload({ objective: 'no attachment field' }), []);
  for (const attachments of [null, {}, 'private-path', 1, false]) {
    assert.throws(
      () => attachmentPayload({ attachments }),
      /attachments 必须是数组/u,
    );
  }
});

test('submit attachment policy rejects silent discard and payload path bypasses', () => {
  const attachment = [{ path: 'fixtures/image.png', kind: 'image' }];
  assert.throws(
    () => validateLocalAttachmentSubmission({
      source: 'connector', trust: 'external', attachments: attachment,
    }),
    /只有 local-cli owner/u,
  );
  assert.throws(
    () => validateLocalAttachmentSubmission({
      source: 'local-cli', trust: 'owner', payload: { attachments: [durableFile()] },
    }),
    /保留字段/u,
  );
  assert.throws(
    () => validateLocalAttachmentSubmission({
      source: 'local-cli', trust: 'owner', payload: {}, attachments: attachment,
    }),
    /显式 payload/u,
  );
  assert.deepEqual(validateLocalAttachmentSubmission({
    source: 'local-cli', trust: 'owner', attachments: attachment,
  }), attachment);
});

test('stable media references are removed from text and parsed exactly once', () => {
  const first = `media-evidence:sha256:${'1'.repeat(64)}`;
  const second = `media-evidence:sha256:${'2'.repeat(64)}`;
  assert.deepEqual(
    parseMediaReferenceInput(`比较原图 @media:${first}\n以及 @media:${second}`),
    { text: '比较原图 \n以及', mediaEvidenceIds: [first, second] },
  );
  assert.deepEqual(mediaEvidenceIdsFromPayload({
    prompt: 'compare',
    referencedMediaEvidenceIds: [first, second],
  }), [first, second]);
  assert.deepEqual(mediaEvidenceIdsFromPayload({ prompt: 'plain' }), []);

  assert.throws(
    () => parseMediaReferenceInput(`重复 @media:${first} @media:${first}`),
    /不能重复/u,
  );
  assert.throws(
    () => parseMediaReferenceInput(`错误 @media:media-evidence:sha256:${'A'.repeat(64)}`),
    /格式无效/u,
  );
  assert.throws(
    () => parseMediaReferenceInput(`错误 @MEDIA:${first}`),
    /格式无效/u,
  );
  assert.throws(() => parseMediaReferenceInput('错误 @media:'), /格式无效/u);
  assert.throws(
    () => parseMediaReferenceInput(Array.from({ length: 9 }, (_, index) =>
      `@media:media-evidence:sha256:${index.toString(16).padStart(64, '0')}`).join(' ')),
    /最多 8 个/u,
  );
  for (const invalid of [null, {}, 'private', 1, false]) {
    assert.throws(
      () => mediaEvidenceIdsFromPayload({ referencedMediaEvidenceIds: invalid }),
      /必须是数组/u,
    );
  }
  assert.throws(
    () => mediaEvidenceIdsFromPayload({ referencedMediaEvidenceIds: [first, first] }),
    /不能重复/u,
  );
  assert.throws(
    () => mediaEvidenceIdsFromPayload({
      referencedMediaEvidenceIds: [`media-evidence:sha256:${'A'.repeat(64)}`],
    }),
    /格式无效/u,
  );
  assert.throws(
    () => mediaEvidenceIdsFromPayload({
      referencedMediaEvidenceIds: Array.from({ length: 9 }, (_, index) =>
        `media-evidence:sha256:${index.toString(16).padStart(64, '0')}`),
    }),
    /最多 8 个/u,
  );
});
