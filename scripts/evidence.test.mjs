import assert from 'node:assert/strict';
import { assertX8664Elf, assertEmptyDeltaRenewal, assertRetainedReleases, assertPreservedReleases, publicReleaseList, boundedFetch } from './evidence.mjs';
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

const retained = { releases: [
  { id: 413497066, tag: 'qa-source-theme-v0.0.1', assets: [{ id: 642968615, name: 'theme.tar.gz', size: 1100 }] },
  { id: 413501761, tag: 'theme-qa-inert-theme-v0.0.1', assets: [{ id: 642988641, name: 'theme.tar.gz', size: 1100 }, { id: 777777777, name: 'publication-plan.json', size: 1200 }] },
] };
assertRetainedReleases(retained);
assertPreservedReleases(retained, { releases: [...retained.releases, { id: 1, assets: [] }] });
for (const change of [x=>x.releases.pop(), x=>x.releases[1].assets[0].id++, x=>x.releases[0].tag='wrong']) {
  const bad = structuredClone(retained); change(bad);
  assert.throws(() => assertRetainedReleases(bad));
  assert.throws(() => assertPreservedReleases(retained, bad));
}

for (const change of [x=>x.releases[1].assets.pop(), x=>x.releases[1].assets.push({id:8,name:'unexpected',size:1}), x=>x.releases[1].assets[1].size=4194305]) {
 const bad=structuredClone(retained);change(bad);assert.throws(()=>assertRetainedReleases(bad));
}

let reads = 0;
const published = [{id:7,draft:false}];
assert.equal(await publicReleaseList(async () => ++reads === 1 ? [] : published, [7], {attempts:2,pauseMs:0}), published);
assert.equal(reads, 2);
await assert.rejects(publicReleaseList(async () => [{id:7,draft:true}], [7], {attempts:2,pauseMs:0}));
await assert.rejects(publicReleaseList(async () => [], [7], {attempts:1,pauseMs:0}));
await assert.rejects(publicReleaseList(async () => Array(100).fill({id:7,draft:false}), [7], {attempts:1,pauseMs:0}));

// A single deadline includes slow requests, not only pauses between attempts.
let deadlineReads = 0;
await assert.rejects(publicReleaseList(async (_path, signal) => {
  deadlineReads++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve([]), 200);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, {once:true});
  });
}, [7], {attempts:31,pauseMs:0,timeoutMs:5}), {name:'TimeoutError'});
assert.equal(deadlineReads, 1);
