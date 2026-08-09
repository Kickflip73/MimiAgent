import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeGeneratedImageArtifact,
  MAX_GENERATED_IMAGE_BYTES,
} from '../src/runtime/generated-image-artifact.js';

describe('generated image artifact decoder', () => {
  it('decodes one inline artifact and returns a stable safe name', () => {
    const source = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const decoded = decodeGeneratedImageArtifact([
      { data: source.toString('base64'), mediaType: 'image/png' },
    ]);

    assert.deepEqual(decoded.bytes, source);
    assert.equal(decoded.mediaType, 'image/png');
    assert.equal(decoded.originalName, 'generated-image.png');
  });

  it('accepts an inline artifact larger than the ledger truncation threshold', () => {
    const source = Buffer.alloc(70 * 1024, 0x5a);

    const decoded = decodeGeneratedImageArtifact([
      { data: source.toString('base64'), mediaType: 'image/webp' },
    ]);

    assert.equal(decoded.bytes.byteLength, source.byteLength);
    assert.deepEqual(decoded.bytes, source);
  });

  it('rejects an oversized artifact before invoking the decoder', () => {
    const encodedLength = Math.ceil((MAX_GENERATED_IMAGE_BYTES + 1) / 3) * 4;
    let decoderCalls = 0;

    assert.throws(
      () => decodeGeneratedImageArtifact(
        [{ data: 'A'.repeat(encodedLength), mediaType: 'image/png' }],
        {
          decodeBase64: () => {
            decoderCalls += 1;
            return Buffer.alloc(0);
          },
        },
      ),
      /exceeds/,
    );
    assert.equal(decoderCalls, 0);
  });

  it('rejects missing, remote, ambiguous, or multiple artifacts', () => {
    const inline = Buffer.from('image').toString('base64');
    const cases = [
      [],
      [{ mediaType: 'image/png', url: 'https://example.invalid/image.png' }],
      [{ data: inline, mediaType: 'image/png', url: 'https://example.invalid/image.png' }],
      [
        { data: inline, mediaType: 'image/png' },
        { data: inline, mediaType: 'image/png' },
      ],
    ];

    for (const artifacts of cases) {
      assert.throws(() => decodeGeneratedImageArtifact(artifacts), /exactly one|inline data only/);
    }
  });

  it('canonicalizes supported MIME casing and rejects unsupported MIME forms', () => {
    const data = Buffer.from('image').toString('base64');
    const decoded = decodeGeneratedImageArtifact([{ data, mediaType: 'ImAgE/JpEg' }]);
    assert.equal(decoded.mediaType, 'image/jpeg');
    assert.equal(decoded.originalName, 'generated-image.jpg');

    for (const mediaType of ['image/svg+xml', 'image/png; charset=binary', ' image/png', 'toString']) {
      assert.throws(
        () => decodeGeneratedImageArtifact([{ data, mediaType }]),
        /MIME is unsupported/,
      );
    }
  });

  it('rejects whitespace, invalid alphabet, missing padding, and noncanonical pad bits', () => {
    for (const data of ['', 'a Gk=', 'aGk*', 'aGk', 'AB==']) {
      assert.throws(
        () => decodeGeneratedImageArtifact([{ data, mediaType: 'image/gif' }]),
        /canonical base64/,
        data,
      );
    }
  });
});
