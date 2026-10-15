import assert from 'node:assert/strict';

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

export async function boundedFetch(url, headers = {}, fetcher = fetch) {
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(60000) });
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
