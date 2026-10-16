import './guard.mjs';
import { interruptPublication, cleanProxyEnv } from './fault-driver.mjs';
import { assertX8664Elf, assertEmptyDeltaRenewal, assertIncrementalTheme, assertRetainedReleases, assertPreservedReleases, publicReleaseList, boundedFetch, inventoryDigest, waitForInventory, waitForObservation } from './evidence.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, appendFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const env = process.env;
const root = join(env.RUNNER_TEMP, 'qa-public');
const state = join(env.RUNNER_TEMP, 'qa-state');
const key = join(env.RUNNER_TEMP, 'qa-private.pem');
assert.ok(!existsSync(state), 'each hosted runner must start without pipeline state');
assert.ok(!existsSync(key), 'secret path must not preexist');
const pin = readFileSync('cli-pin.env', 'utf8');
assert.equal(pin, 'CADENCR_RELEASE_VERSION=0.13.1-dev.38974097824.1\nCADENCR_RELEASE_SHA256=ee3516bb5ad7ed143428f255e9e4dd24d9f13003061a803c99be8f3fd8db9a7e\nCADENCR_RELEASE_TAG=cli/v0.13.1-dev.38974097824.1\n');
const binary = join(env.RUNNER_TEMP, 'qa-cli/cadencr');
const binaryStat = lstatSync(binary);
assert.ok(binaryStat.isFile() && !binaryStat.isSymbolicLink());
const binaryBytes = readFileSync(binary);
assert.equal(createHash('sha256').update(binaryBytes).digest('hex'), 'ee3516bb5ad7ed143428f255e9e4dd24d9f13003061a803c99be8f3fd8db9a7e');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 });
assert.equal(version.status, 0);
assert.equal(version.stdout, 'cadencr 0.13.1-dev.38974097824.1\n');
assertX8664Elf(binaryBytes.subarray(0, 64));
mkdirSync(root, { mode: 0o700 });
const previousIndex = env.PHASE === 'fault' ? 'requests/previous-fault.json' : 'requests/previous.json';
if (env.PHASE !== 'initial') verifyIndex(previousIndex);
assert.ok(env.QA_SIGNING_KEY_PEM && Buffer.byteLength(env.QA_SIGNING_KEY_PEM) <= 16384);
writeFileSync(key, env.QA_SIGNING_KEY_PEM, { flag: 'wx', mode: 0o600 });
delete env.QA_SIGNING_KEY_PEM;
try {
  const args = ['registry', 'publish-registry', '--request', `requests/${env.PHASE}.json`,
    '--directory', state, '--repository', 'merkr-software/cadencr-registry-qa',
    '--registry-commit', env.REVIEWED_COMMIT, '--private-key', key,
    '--confirm-request-sha256', env.REQUEST_SHA256];
  const before = env.QA_RUNNER === 'fresh'
    ? await waitForInventory(signal => remoteInventory([], signal), env.QA_EXPECTED_INVENTORY_SHA256)
    : await remoteInventory();
  let baseline = env.QA_RUNNER === 'fresh' ? before : undefined;
  let interruption;
  if (env.PHASE === 'fault' && env.QA_RUNNER === 'first') {
    interruption = await interruptPublication({ binary, args, env, state,
      smokeDirectory: join(env.RUNNER_TEMP, 'qa-proxy-smoke'),
      expectedTag: 'theme-qa-inert-theme-v0.0.2', expectedCommit: env.REVIEWED_COMMIT,
      expectedSha256: 'feb4ba028cbb4abf9014284322d7920ad647e7c26318db586c8a50d9326ceb17' });
    writeFileSync(join(root, 'interruption.json'), `${JSON.stringify(interruption, null, 2)}\n`, {flag:'wx'});
  }
  for (const attempt of ['publish', 'same-state-replay']) {
    const result = spawnSync(join(env.RUNNER_TEMP, 'qa-cli/cadencr'), args, { stdio: 'inherit', env: cleanProxyEnv(env), timeout: 900000, killSignal: 'SIGKILL' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${attempt} failed`);
    const catalog = JSON.parse(readFileSync(join(state, 'catalog-publication-receipt.json')));
    const discovery = JSON.parse(readFileSync(join(state, 'discovery-receipt.json')));
    assert.equal(catalog.status, 'published_verified');
    assert.equal(discovery.status, 'discovery_verified');
    assert.equal(discovery.branch, 'marketplace-v2');
    if (env.PHASE !== 'renewal') {
      const expectedTag = `theme-qa-inert-theme-v0.0.${env.PHASE === 'initial' ? '1' : '2'}`;
      const mirrors = readdirSync(join(state, 'publications')).map(directory =>
        JSON.parse(readFileSync(join(state, 'publications', directory, 'mirror-receipt.json'))));
      const matches = mirrors.filter(mirror => mirror.release_tag === expectedTag);
      assert.equal(matches.length, 1);
      const mirror = matches[0];
      if (env.QA_RUNNER === 'fresh') assert.equal(mirror.status, 'published_recovered');
      writeFileSync(join(root, `${attempt}-mirror.json`), `${JSON.stringify(mirror, null, 2)}\n`);
    }
    assert.equal(catalog.repository, env.GITHUB_REPOSITORY);
    assert.equal(catalog.registry_commit, env.REVIEWED_COMMIT);
    assert.equal(catalog.tag_commit, env.REVIEWED_COMMIT);
    const bytes = await boundedFetch(catalog.catalog_url);
    assert.equal(bytes.length, catalog.catalog_size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), catalog.catalog_sha256);
    const index = join(root, `${attempt}-index.json`);
    writeFileSync(index, bytes);
    verifyIndex(index);
    if (env.PHASE === 'renewal') assertEmptyDeltaRenewal(JSON.parse(readFileSync(previousIndex)), JSON.parse(bytes));
    if (env.PHASE === 'fault') assertIncrementalTheme(JSON.parse(readFileSync(previousIndex)), JSON.parse(bytes));
    const inventory = await postPublicationInventory([413497066, 413501761, catalog.release_id], discovery.blob_sha);
    assertRetainedReleases(inventory);
    if (interruption) {
      const managed = inventory.releases.find(release => release.tag === 'theme-qa-inert-theme-v0.0.2');
      assert.equal(managed?.id, interruption.releaseId, 'resume replaced the interrupted release');
      const original = interruption.assets.map(({id,name,size}) => ({id,name,size})).sort((a,b)=>a.id-b.id);
      assert.deepEqual(managed.assets, original, 'resume replaced interrupted assets');
    }
    assertPreservedReleases(before, inventory);
    if (baseline) assert.deepEqual(inventory, baseline, 'replay changed remote IDs');
    baseline = inventory;
    const receipt = { attempt, request_sha256: env.REQUEST_SHA256, registry_commit: env.REVIEWED_COMMIT,
      repository: env.GITHUB_REPOSITORY, catalog, discovery, inventory };
    writeFileSync(join(root, `${attempt}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${env.PHASE}: ${attempt}\n\n- Request: \`${env.REQUEST_SHA256}\`\n- Commit: \`${env.REVIEWED_COMMIT}\`\n- Catalog/discovery receipts verified; see public diagnostic artifact.\n`);
  }
  if (env.QA_RUNNER === 'first') {
    appendFileSync(env.GITHUB_OUTPUT, `inventory_sha256=${inventoryDigest(baseline)}\n`);
  }
} finally {
  unlinkSync(key); // Only the task-owned secret, never state or a database.
}

async function remoteInventory(requiredIds = [], signal = AbortSignal.timeout(60000)) {
  const get = (path, requestSignal = signal) => inventoryApi(path, requestSignal);
  const releases = (await publicReleaseList(get, requiredIds, { signal })).filter(release => release.draft === false);
  for (const release of releases) {
    release.assets = await get(`/releases/${release.id}/assets?per_page=100`);
    assert.ok(release.assets.length < 100, 'assets inventory must not silently truncate');
  }
  const head = await get('/git/ref/heads/marketplace-v2');
  return { head: head.object.sha, releases: releases.map(r => ({ id: r.id, tag: r.tag_name, assets: r.assets.map(a => ({id:a.id,name:a.name,size:a.size})).sort((a,b)=>a.id-b.id) })).sort((a,b)=>a.id-b.id) };
}

// Job-token API observations are identity assertions, not anonymous availability proof.
async function inventoryApi(path, signal) {
  assert.ok(env.CADENCR_REGISTRY_GITHUB_TOKEN, 'inventory requires the ephemeral QA job token');
  const base = 'https://api.github.com/repos/merkr-software/cadencr-registry-qa';
  const headers = { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache',
    Authorization: `Bearer ${env.CADENCR_REGISTRY_GITHUB_TOKEN}` };
  return JSON.parse(await boundedFetch(base + path, headers, fetch, signal));
}

async function postPublicationInventory(requiredIds, expectedBlob) {
  assert.match(expectedBlob ?? '', /^[a-f0-9]{40}$(?![\s\S])/);
  const observed = await waitForObservation(async signal => {
    const inventory = await remoteInventory(requiredIds, signal);
    const file = await inventoryApi(`/contents/managed-index.json?ref=${inventory.head}`, signal);
    return { inventory, blob: file.sha };
  }, observation => observation.blob === expectedBlob);
  return observed.inventory;
}

function verifyIndex(index) {
  const result = spawnSync(join(env.RUNNER_TEMP, 'qa-cli/cadencr'), ['registry', 'verify-index', '--index', index, '--public-key', 'requests/public.pem', '--key-id', 'qa-2026'], { stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'index signature verification failed');
}
