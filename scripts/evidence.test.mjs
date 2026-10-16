import assert from 'node:assert/strict';
import { assertX8664Elf, assertEmptyDeltaRenewal, assertIncrementalTheme, assertRetainedReleases, assertPreservedReleases, publicReleaseList, boundedFetch, inventoryDigest, waitForInventory, waitForObservation } from './evidence.mjs';
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

const priorTheme={signed:{packages:[{kind:'theme',package:{theme:{id:'qa-inert-theme',version:'0.0.1'}}}]}};
const addedTheme={kind:'theme',package:{theme:{id:'qa-inert-theme',version:'0.0.2',distribution:{archive:'https://github.com/merkr-software/cadencr-registry-qa/releases/download/theme-qa-inert-theme-v0.0.2/theme.tar.gz',sha256:'feb4ba028cbb4abf9014284322d7920ad647e7c26318db586c8a50d9326ceb17'}}}};
const incremental={signed:{packages:[...priorTheme.signed.packages,addedTheme]}};
assertIncrementalTheme(priorTheme,incremental);
for(const mutate of [x=>x.signed.packages.shift(),x=>x.signed.packages[0].package.theme.version='other',x=>x.signed.packages[1].package.theme.distribution.sha256='bad']) {
 const bad=structuredClone(incremental);mutate(bad);assert.throws(()=>assertIncrementalTheme(priorTheme,bad));
}

// A fresh runner must observe the entire first runner inventory, not just IDs.
const staleInventory = {head:'old',releases:[{id:7,tag:'catalog',assets:[]}]};
const currentInventory = {head:'new',releases:[{id:7,tag:'catalog',assets:[{id:8,name:'index.json',size:20}]}]};
const expectedDigest = inventoryDigest(currentInventory);
assert.equal(inventoryDigest({releases:currentInventory.releases,head:'new'}), expectedDigest);
assert.notEqual(inventoryDigest(staleInventory), expectedDigest);
let inventoryReads = 0;
const seenSignals = [];
assert.equal(await waitForInventory(async signal => {
  seenSignals.push(signal);
  return ++inventoryReads === 1 ? staleInventory : currentInventory;
}, expectedDigest, {pauseMs:0}), currentInventory);
assert.equal(inventoryReads, 2);
assert.equal(seenSignals[0], seenSignals[1]);
await assert.rejects(waitForInventory(async () => staleInventory, expectedDigest, {timeoutMs:5,pauseMs:1}), {name:'AbortError'});
let fullReadSignal;
await assert.rejects(waitForInventory(async signal => {
  fullReadSignal = signal;
  await publicReleaseList(async (_path, listSignal) => {
    assert.equal(listSignal, signal);
    return [{id:7,draft:false}];
  }, [7], {signal});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(currentInventory), 200);
    signal.addEventListener('abort', () => {clearTimeout(timer);reject(signal.reason);}, {once:true});
  });
}, expectedDigest, {timeoutMs:5,pauseMs:0}), {name:'TimeoutError'});
assert.equal(fullReadSignal.aborted, true);
const unordered = {head:'new',releases:[
  {id:9,tag:'second',assets:[]},
  {id:7,tag:'catalog',assets:[{id:10,name:'other',size:1},{id:8,name:'index.json',size:20}]},
]};
const ordered = {head:'new',releases:[
  {id:7,tag:'catalog',assets:[{id:8,name:'index.json',size:20},{id:10,name:'other',size:1}]},
  {id:9,tag:'second',assets:[]},
]};
assert.equal(inventoryDigest(unordered), inventoryDigest(ordered));

// An observed branch head is accepted only when its immutable file blob matches
// the real CLI discovery receipt, even when release identities already match.
const wantedBlob = 'b'.repeat(40);
const observations = [
  {inventory:staleInventory,blob:'a'.repeat(40)},
  {inventory:currentInventory,blob:wantedBlob},
];
let blobReads = 0;
const blobSignals = [];
const accepted = await waitForObservation(async signal => {
  blobSignals.push(signal);
  return observations[blobReads++];
}, observation => observation.blob === wantedBlob, {pauseMs:0});
assert.equal(accepted, observations[1]);
assert.equal(blobReads, 2);
assert.equal(blobSignals[0], blobSignals[1]);
await assert.rejects(waitForObservation(async () => ({
  inventory:currentInventory,blob:'a'.repeat(40),
}), observation => observation.blob === wantedBlob, {timeoutMs:5,pauseMs:1}), {name:'AbortError'});
