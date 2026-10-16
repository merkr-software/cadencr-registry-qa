import test from 'node:test';
import assert from 'node:assert/strict';
import { assertInterrupted, boundedExit, cleanProxyEnv, matchesRelease } from './fault-driver.mjs';

const valid = { code: 1, signal: null, exitTime: 30, observedTime: 10, faultTime: 20, firstFaultReason: 'injected',
  lockExists: false, discoveryExists: false };

test('accepts only normal nonzero exit after sentinel and fault', () => {
  assert.doesNotThrow(() => assertInterrupted(valid));
  for (const patch of [{ code: 0 }, { code: null }, { signal: 'SIGTERM' },
    { spawnError: true }, { observedTime: undefined }, { faultTime: undefined },
    { faultTime: 30 }, { faultTime: 31 }, { observedTime: 21 },
    { lockExists: true }, { discoveryExists: true }]) {
    assert.throws(() => assertInterrupted({ ...valid, ...patch }));
  }
});

test('proxy env starts clean and public smoke removes credentials', () => {
  const original = { HTTPS_PROXY: 'old', http_proxy: 'old', ALL_PROXY: 'old',
    no_proxy: '*', NODE_USE_ENV_PROXY: '1', CADENCR_REGISTRY_GITHUB_TOKEN: 'sensitive',
    GH_TOKEN: 'sensitive', PATH: '/bin' };
  assert.deepEqual(cleanProxyEnv(original, 'http://localhost:1', true), {
    PATH: '/bin', HTTPS_PROXY: 'http://localhost:1',
  });
  assert.equal(cleanProxyEnv(original, 'new').CADENCR_REGISTRY_GITHUB_TOKEN, 'sensitive');
  assert.equal(original.HTTPS_PROXY, 'old');
});

test('sentinel requires exact publication and archive plus bounded provenance asset', () => {
  const expected = { expectedTag: 'theme/0.0.2', expectedCommit: 'a'.repeat(40),
    expectedSha256: 'b'.repeat(64), expectedSize: 1100 };
  const asset = { id: 2, name: 'theme.tar.gz', size: 1100, digest: `sha256:${expected.expectedSha256}` };
  const plan = { id: 3, name: 'publication-plan.json', size: 800, digest: `sha256:${'c'.repeat(64)}` };
  const release = { id: 1, tag_name: expected.expectedTag, target_commitish: expected.expectedCommit,
    draft: false, assets: [asset, plan] };
  assert.equal(matchesRelease(release, expected), true);
  assert.equal(matchesRelease({ ...release, assets: [plan, asset] }, expected), true);
  const invalidAssets = [[], [asset], [plan], [asset, plan, plan], [asset, asset],
    [{ ...asset, size: 1099 }, plan], [{ ...asset, digest: null }, plan],
    [{ ...asset, name: 'other' }, plan], [{ ...asset, id: 0 }, plan],
    [asset, { ...plan, id: asset.id }], [asset, { ...plan, id: -1 }],
    [asset, { ...plan, id: Number.MAX_SAFE_INTEGER + 1 }], [asset, { ...plan, size: 0 }],
    [asset, { ...plan, size: 4194305 }], [asset, { ...plan, size: 1.5 }],
    [asset, { ...plan, digest: '' }], [asset, { ...plan, digest: 'sha256:ABC' }],
    [asset, { ...plan, digest: null }], [asset, { ...plan, name: 'other' }]];
  for (const patch of [{ tag_name: 'other' }, { target_commitish: 'other' }, { draft: true },
    { id: 0 }, { id: -1 }, { id: Number.MAX_SAFE_INTEGER + 1 },
    ...invalidAssets.map(assets => ({ assets }))]) {
    assert.equal(matchesRelease({ ...release, ...patch }, expected), false);
  }
});

// These are helper regressions, not substitute evidence for live interruption.
test('pre-observed automatic fault cannot be relabeled as injected', () => {
  assert.throws(() => assertInterrupted({ ...valid, faultTime: 5, firstFaultReason: 'byte-limit' }));
  assert.throws(() => assertInterrupted({ ...valid, firstFaultReason: 'byte-limit' }));
  assert.throws(() => assertInterrupted({ ...valid, firstFaultReason: undefined }));
});

test('terminal exit timeout unreferences child without killing it', async () => {
  let unrefs = 0;
  const process = { completion: new Promise(() => {}), child: { unref() { unrefs++; } } };
  await assert.rejects(boundedExit(process, 1), /inconclusive, no process killed/);
  assert.equal(unrefs, 1);
});

test('nonterminal observation timeout retains child for bounded cleanup', async () => {
  let unrefs = 0;
  const process = { completion: new Promise(() => {}), child: { unref() { unrefs++; } } };
  await assert.rejects(boundedExit(process, 1, false), /deadline exceeded/);
  assert.equal(unrefs, 0);
  await assert.rejects(boundedExit(process, 1), /deadline exceeded/);
  assert.equal(unrefs, 1);
});

test('normal exit does not unreference child', async () => {
  let unrefs = 0;
  const status = { code: 1 };
  const process = { completion: Promise.resolve(status), child: { unref() { unrefs++; } } };
  assert.equal(await boundedExit(process, 100), status);
  assert.equal(unrefs, 0);
});
