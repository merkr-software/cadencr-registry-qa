// LOCAL before-review/commit preparation only; never run in the signing workflow.
// Usage: node scripts/prepare-renewal.mjs PREVIOUS_INDEX GENERATED_AT EXPIRES_AT REQUESTS_DIR
// The released CLI must authenticate PREVIOUS_INDEX before this helper is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'merkr-software/cadencr-registry-qa';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function timestamp(value) {
  assert.equal(typeof value, 'string', 'timestamp must be a string');
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'whole-second UTC required');
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time), 'invalid date');
  assert.equal(new Date(time).toISOString(), value.replace('Z', '.000Z'), 'invalid calendar date');
  return time;
}

// Pure deterministic formatting/shape checks, NOT cryptographic authentication.
export function prepareRenewal(previousBytes, generatedAt, expiresAt) {
  assert.ok(Buffer.isBuffer(previousBytes), 'previous index must be bytes');
  assert.ok(previousBytes.length > 0 && previousBytes.length <= 4 * 1024 * 1024, 'index size invalid');
  const previous = JSON.parse(previousBytes.toString('utf8'));
  assert.ok(object(previous) && object(previous.signed), 'signed envelope required');
  assert.ok(object(previous.signature), 'signature shape required');
  assert.equal(previous.signature.key_id, 'qa-2026', 'QA key id required');
  assert.ok(typeof previous.signature.value === 'string' && previous.signature.value.length > 0, 'signature value required');
  const signed = previous.signed;
  assert.equal(signed.schema_version, 2, 'schema 2 required');
  assert.ok(Array.isArray(signed.packages) && signed.packages.every(object), 'packages must be objects');
  // Schema 2 has no repository field; reject a foreign claim if one is present.
  for (const value of [previous.repository, signed.repository]) {
    if (value !== undefined) assert.equal(value, repository, 'foreign repository');
  }
  const previousGeneration = timestamp(signed.generated_at);
  assert.ok(timestamp(signed.expires_at) > previousGeneration, 'invalid baseline lifetime');
  const generated = timestamp(generatedAt);
  const expires = timestamp(expiresAt);
  assert.ok(generated > previousGeneration, 'renewal must be newer than baseline');
  assert.ok(expires > generated && expires - generated <= 14 * 86400000, 'lifetime must be positive and at most 14 days');
  const request = { schema_version: 2, repository, key_id: 'qa-2026', discovery_branch: 'marketplace-v2',
    generated_at: generatedAt, expires_at: expiresAt, previous_index: 'previous.json', public_key: 'public.pem', publications: [] };
  const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  return { previousBytes: Buffer.from(previousBytes), requestBytes,
    requestSha256: digest(requestBytes), previousSha256: digest(previousBytes) };
}

function absent(path) {
  try { lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing existing destination: ${path}`);
}

export function writeRenewal(previousPath, generatedAt, expiresAt, outputDirectory) {
  const source = lstatSync(previousPath);
  assert.ok(source.isFile() && !source.isSymbolicLink(), 'source must be a regular file');
  assert.ok(source.size <= 4 * 1024 * 1024, 'index too large');
  const prepared = prepareRenewal(readFileSync(previousPath), generatedAt, expiresAt);
  const directory = lstatSync(outputDirectory);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), 'requests directory must be a real directory');
  const previousDestination = join(outputDirectory, 'previous.json');
  const requestDestination = join(outputDirectory, 'renewal.json');
  absent(previousDestination);
  absent(requestDestination);
  // Exclusive writes also reject races/symlinks. A partial failure leaves created
  // files untouched for inspection; nothing is removed or overwritten.
  writeFileSync(previousDestination, prepared.previousBytes, { flag: 'wx' });
  writeFileSync(requestDestination, prepared.requestBytes, { flag: 'wx' });
  return prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 6,
    'Usage: node scripts/prepare-renewal.mjs PREVIOUS_INDEX GENERATED_AT EXPIRES_AT REQUESTS_DIR');
  const prepared = writeRenewal(...process.argv.slice(2));
  console.log(`request_sha256: ${prepared.requestSha256}\nsource_baseline_sha256: ${prepared.previousSha256}`);
}
