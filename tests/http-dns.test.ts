import assert from 'node:assert/strict';
import { lookup, type LookupAddress } from 'node:dns';
import test from 'node:test';
import { createPublicHttpLookup } from '../src/tools.js';

function resolver(addresses: LookupAddress[], error: NodeJS.ErrnoException | null = null): typeof lookup {
  return ((_host: string, options: { all?: boolean }, callback: Function) => {
    assert.equal(options.all, true);
    callback(error, addresses);
  }) as unknown as typeof lookup;
}

const publicAddresses = [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }];

test('public HTTP DNS returns address arrays for automatic family selection', () => {
  createPublicHttpLookup(resolver(publicAddresses))('example.test', { all: true }, (error, addresses, family) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, publicAddresses);
    assert.equal(family, undefined);
  });
});

test('public HTTP DNS preserves single-address callback compatibility', () => {
  createPublicHttpLookup(resolver(publicAddresses))('example.test', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
});

test('public HTTP DNS rejects mixed private/public and empty results in both modes', () => {
  for (const all of [true, false]) {
    for (const addresses of [[], [...publicAddresses, { address: '127.0.0.1', family: 4 }]]) {
      createPublicHttpLookup(resolver(addresses))('example.test', { all }, (error) => {
        assert.equal(error?.code, 'EACCES');
      });
    }
  }
});

test('public HTTP DNS preserves resolution errors', () => {
  const failure = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  createPublicHttpLookup(resolver([], failure))('example.test', { all: true }, (error) => {
    assert.equal(error, failure);
  });
});
