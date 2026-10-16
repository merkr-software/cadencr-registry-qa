import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

export function assertX8664Elf(bytes) {
  assert.ok(bytes.length >= 64, 'ELF header is truncated');
  assert.deepEqual(bytes.subarray(0, 7), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), 'requires ELF64 little-endian v1');
  assert.equal(bytes.readUInt16LE(18), 62, 'requires x86_64 ELF machine');
  assert.equal(bytes.readUInt32LE(20), 1, 'requires ELF version 1');
}

// Caller MUST authenticate both envelopes with the pinned CLI before comparing.
export function assertEmptyDeltaRenewal(previous, current) {
  assert.ok(Array.isArray(previous.signed.packages) && Array.isArray(current.signed.packages));
  assert.deepEqual(current.signed.packages, previous.signed.packages, 'renewal changed signed packages');
  assert.equal(current.signed.schema_version, previous.signed.schema_version, 'renewal changed schema');
  const before = Date.parse(previous.signed.generated_at);
  const after = Date.parse(current.signed.generated_at);
  assert.ok(Number.isFinite(before) && Number.isFinite(after) && after > before, 'renewal date must advance');
}

export async function boundedFetch(url, headers = {}, fetcher = fetch, signal = AbortSignal.timeout(60000)) {
  const response = await fetcher(url, { headers, signal });
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers.get('content-length') ?? 0) <= 4194304);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 4194304, 'public response exceeds 4 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Public immutable identities retained from the two earlier failed QA runs.
export function assertRetainedReleases(inventory) {
  for (const expected of [
    { id: 413497066, tag: 'qa-source-theme-v0.0.1', assets: [{ id: 642968615, name: 'theme.tar.gz', size: 1100 }] },
    { id: 413501761, tag: 'theme-qa-inert-theme-v0.0.1', assets: [{ id: 642988641, name: 'theme.tar.gz', size: 1100 }] },
  ]) {
    const actual = inventory.releases.find(release => release.id === expected.id);
    assert.equal(actual?.tag, expected.tag, 'retained release identity changed');
    for (const asset of expected.assets) {
      assert.deepEqual(actual.assets.find(item => item.id === asset.id), asset, 'retained archive identity changed');
    }
    const names = actual.assets.map(asset => asset.name).sort();
    assert.deepEqual(names, expected.id === 413501761
      ? ['publication-plan.json', 'theme.tar.gz'] : ['theme.tar.gz'], 'unexpected managed/source assets');
    const plan = actual.assets.find(asset => asset.name === 'publication-plan.json');
    if (plan) assert.ok(Number.isSafeInteger(plan.id) && plan.id > 0 && plan.size > 0 && plan.size <= 4194304);
  }
}

export function assertPreservedReleases(before, after) {
  for (const release of before.releases) {
    assert.deepEqual(after.releases.find(item => item.id === release.id), release,
      'publication changed a previously public release or asset');
  }
}

// GitHub's anonymous release LIST can lag a successful public byte check.
// Retry reads only; never synthesize or rewrite inventory contents.
export async function publicReleaseList(get, requiredIds, { attempts = 31, pauseMs = 2000, timeoutMs = 60000, signal: sharedSignal } = {}) {
  assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 31);
  assert.ok(Number.isFinite(pauseMs) && pauseMs >= 0 && pauseMs <= 2000);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
  const signal = sharedSignal ?? AbortSignal.timeout(timeoutMs);
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted();
    const releases = await get('/releases?per_page=100', signal);
    signal.throwIfAborted();
    assert.ok(Array.isArray(releases) && releases.length < 100, 'inventory must not silently truncate');
    if (requiredIds.every(id => releases.some(release => release.id === id && release.draft === false))) return releases;
    if (attempt + 1 < attempts) await sleep(pauseMs, undefined, { signal });
  }
  throw new Error('Public release inventory did not converge within its read deadline');
}

// Caller authenticates both signed envelopes with the pinned distributed CLI.
export function assertIncrementalTheme(previous, current) {
  const before = previous.signed.packages;
  const after = current.signed.packages;
  assert.equal(after.length, before.length + 1, 'expected exactly one new package version');
  for (const entry of before) assert.ok(after.some(candidate => isDeepStrictEqual(candidate, entry)), 'historical package changed');
  const added = after.filter(entry => !before.some(candidate => isDeepStrictEqual(candidate, entry)));
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'theme');
  const theme = added[0].package.theme;
  assert.equal(theme.id, 'qa-inert-theme');
  assert.equal(theme.version, '0.0.2');
  assert.equal(theme.distribution.archive, 'https://github.com/merkr-software/cadencr-registry-qa/releases/download/theme-qa-inert-theme-v0.0.2/theme.tar.gz');
  assert.equal(theme.distribution.sha256, 'feb4ba028cbb4abf9014284322d7920ad647e7c26318db586c8a50d9326ceb17');
}

// Hash only normalized public observations, never local CLI state.
export function inventoryDigest(inventory) {
  const normalized = { head: inventory.head, releases: inventory.releases.map(release => ({
    id: release.id, tag: release.tag, assets: release.assets.map(asset => ({
      id: asset.id, name: asset.name, size: asset.size,
    })).sort((a, b) => a.id - b.id),
  })).sort((a, b) => a.id - b.id) };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export async function waitForInventory(read, expected, { timeoutMs = 60000, pauseMs = 2000 } = {}) {
  assert.match(expected, /^[a-f0-9]{64}$(?![\s\S])/);
  return waitForObservation(read, inventory => inventoryDigest(inventory) === expected, { timeoutMs, pauseMs });
}

export async function waitForObservation(read, accepts, { timeoutMs = 60000, pauseMs = 2000 } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
  assert.ok(Number.isFinite(pauseMs) && pauseMs >= 0 && pauseMs <= 2000);
  const signal = AbortSignal.timeout(timeoutMs);
  while (true) {
    signal.throwIfAborted();
    const inventory = await read(signal);
    signal.throwIfAborted();
    if (accepts(inventory)) return inventory;
    await sleep(pauseMs, undefined, { signal });
  }
}
