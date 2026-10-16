import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRenewal, writeRenewal } from './prepare-renewal.mjs';
const fixture = { signed: { schema_version: 2, generated_at: '2026-10-15T06:48:03Z',
  expires_at: '2026-10-22T06:48:03Z', packages: [{ kind: 'theme', package: { theme: { id: 'qa-inert-theme' } } }] },
  signature: { key_id: 'qa-2026', value: 'shape-only-not-authenticated' } };
const bytes = Buffer.from(` ${JSON.stringify(fixture)}\n\n`);
const generation = '2026-10-16T06:48:03Z';
const expiration = '2026-10-23T06:48:03Z';
const prepared = prepareRenewal(bytes, generation, expiration);
assert.deepEqual(prepared.previousBytes, bytes);
assert.deepEqual(JSON.parse(prepared.requestBytes), { schema_version: 2,
  repository: 'merkr-software/cadencr-registry-qa', key_id: 'qa-2026', discovery_branch: 'marketplace-v2',
  generated_at: generation, expires_at: expiration, previous_index: 'previous.json', public_key: 'public.pem', publications: [] });
assert.equal(prepared.requestSha256, createHash('sha256').update(prepared.requestBytes).digest('hex'));
assert.deepEqual(prepareRenewal(bytes, generation, expiration), prepared);
for (const date of ['2026-02-30T00:00:00Z', '2026-10-16T06:48:03.000Z', '2026-10-16T06:48:03+00:00',
  '2026-10-15T06:48:03Z', '2026-10-14T00:00:00Z', 'bad']) {
  assert.throws(() => prepareRenewal(bytes, date, expiration));
}
for (const expiry of [generation, '2026-10-16T00:00:00Z', '2026-10-30T06:48:04Z', 'bad']) {
  assert.throws(() => prepareRenewal(bytes, generation, expiry));
}
prepareRenewal(bytes, generation, '2026-10-30T06:48:03Z'); // Inclusive 14-day boundary.
for (const mutate of [x => x.signed.schema_version = 1, x => x.signed.packages = {},
  x => x.signed.packages = [null], x => x.repository = 'production/repo',
  x => x.signed.repository = 'production/repo', x => x.signature.key_id = 'production',
  x => x.signature.value = '', x => delete x.signature, x => x.signed.expires_at = 'bad']) {
  const invalid = structuredClone(fixture); mutate(invalid);
  assert.throws(() => prepareRenewal(Buffer.from(JSON.stringify(invalid)), generation, expiration));
}
const root = mkdtempSync(join(tmpdir(), 'qa-renewal-test-'));
const source = join(root, 'source.json'); writeFileSync(source, bytes);
const output = join(root, 'requests'); mkdirSync(output);
writeRenewal(source, generation, expiration, output);
assert.deepEqual(readFileSync(join(output, 'previous.json')), bytes);
assert.deepEqual(readFileSync(join(output, 'renewal.json')), prepared.requestBytes);
assert.throws(() => writeRenewal(source, generation, expiration, output));
assert.deepEqual(readFileSync(source), bytes);
for (const name of ['previous.json', 'renewal.json']) {
  for (const symlink of [false, true]) {
    const dir = mkdtempSync(join(root, 'collision-'));
    const destination = join(dir, name);
    if (symlink) symlinkSync(join(root, 'missing-target'), destination);
    else writeFileSync(destination, 'preserve');
    assert.throws(() => writeRenewal(source, generation, expiration, dir));
    assert.equal(existsSync(join(dir, name === 'previous.json' ? 'renewal.json' : 'previous.json')), false);
    if (!symlink) assert.equal(readFileSync(destination, 'utf8'), 'preserve');
  }
}
const invalidDir = mkdtempSync(join(root, 'invalid-'));
assert.throws(() => writeRenewal(source, 'bad', expiration, invalidDir));
assert.equal(existsSync(join(invalidDir, 'previous.json')), false);
const linkedSource = join(root, 'linked-source'); symlinkSync(source, linkedSource);
assert.throws(() => writeRenewal(linkedSource, generation, expiration, invalidDir));
const linkedDir = join(root, 'linked-directory'); symlinkSync(invalidDir, linkedDir);
assert.throws(() => writeRenewal(source, generation, expiration, linkedDir));
const code = readFileSync(new URL('./prepare-renewal.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(code, /Date\.now|fetch\s*\(|process\.env|child_process|https?:\/\//);
console.log('Renewal preparation tests passed (no signature authentication claimed)');
