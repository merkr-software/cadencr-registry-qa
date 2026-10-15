import assert from 'node:assert/strict';
import { assertX8664Elf, assertEmptyDeltaRenewal, boundedFetch } from './evidence.mjs';
const elf = Buffer.alloc(64);
Buffer.from([0x7f,0x45,0x4c,0x46,2,1,1]).copy(elf);
elf.writeUInt16LE(62,18);
elf.writeUInt32LE(1,20);
assertX8664Elf(elf);
for (const index of [0,4,5,6,18,20]) {
  const bad = Buffer.from(elf); bad[index] = 0;
  assert.throws(() => assertX8664Elf(bad));
}
assert.throws(() => assertX8664Elf(elf.subarray(0,63)));
const old = { signed: { schema_version:2, packages:[{id:'qa',sha256:'abc'}], generated_at:'2026-10-15T00:00:00Z' } };
const renewed = structuredClone(old); renewed.signed.generated_at = '2026-10-16T00:00:00Z';
assertEmptyDeltaRenewal(old, renewed);
for (const mutate of [x=>x.signed.packages[0].sha256='evil', x=>x.signed.packages=[], x=>x.signed.schema_version=1,
  x=>x.signed.generated_at=old.signed.generated_at, x=>x.signed.generated_at='bad']) {
  const bad = structuredClone(renewed); mutate(bad);
  assert.throws(() => assertEmptyDeltaRenewal(old,bad));
}
const fake = (body, length, status=200) => async () => ({ status, headers: new Headers(length === undefined ? {} : {'content-length':String(length)}), body });
assert.equal((await boundedFetch('https://example.invalid', {}, fake([Buffer.from('ok')]))).toString(),'ok');
await assert.rejects(boundedFetch('https://example.invalid', {}, fake([],4194305)));
await assert.rejects(boundedFetch('https://example.invalid', {}, fake([Buffer.alloc(4194305)])));
await assert.rejects(boundedFetch('https://example.invalid', {}, fake([],0,500)));
console.log('Evidence helper tests passed');
