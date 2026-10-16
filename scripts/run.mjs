import './guard.mjs';
import { assertX8664Elf, assertEmptyDeltaRenewal, assertRetainedReleases, assertPreservedReleases, boundedFetch } from './evidence.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, appendFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const env = process.env;
const root = join(env.RUNNER_TEMP, 'qa-public');
const state = join(env.RUNNER_TEMP, 'qa-state');
const key = join(env.RUNNER_TEMP, 'qa-private.pem');
assert.ok(!existsSync(state), 'each hosted runner must start without pipeline state');
assert.ok(!existsSync(key), 'secret path must not preexist');
const pin = readFileSync('cli-pin.env', 'utf8');
assert.equal(pin, 'CADENCR_RELEASE_VERSION=0.13.1-dev.38947325650.1\nCADENCR_RELEASE_SHA256=0cf516ce62da03e52d56502d6da977908282058138e62164ab65eea4982c79f3\nCADENCR_RELEASE_TAG=cli/v0.13.1-dev.38947325650.1\n');
const binary = join(env.RUNNER_TEMP, 'qa-cli/cadencr');
const binaryStat = lstatSync(binary);
assert.ok(binaryStat.isFile() && !binaryStat.isSymbolicLink());
const binaryBytes = readFileSync(binary);
assert.equal(createHash('sha256').update(binaryBytes).digest('hex'), '0cf516ce62da03e52d56502d6da977908282058138e62164ab65eea4982c79f3');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 });
assert.equal(version.status, 0);
assert.equal(version.stdout, 'cadencr 0.13.1-dev.38947325650.1\n');
assertX8664Elf(binaryBytes.subarray(0, 64));
mkdirSync(root, { mode: 0o700 });
if (env.PHASE === 'renewal') verifyIndex('requests/previous.json');
assert.ok(env.QA_SIGNING_KEY_PEM && Buffer.byteLength(env.QA_SIGNING_KEY_PEM) <= 16384);
writeFileSync(key, env.QA_SIGNING_KEY_PEM, { flag: 'wx', mode: 0o600 });
delete env.QA_SIGNING_KEY_PEM;
try {
  const args = ['registry', 'publish-registry', '--request', `requests/${env.PHASE}.json`,
    '--directory', state, '--repository', 'merkr-software/cadencr-registry-qa',
    '--registry-commit', env.REVIEWED_COMMIT, '--private-key', key,
    '--confirm-request-sha256', env.REQUEST_SHA256];
  const before = await remoteInventory();
  let baseline = env.QA_RUNNER === 'fresh' ? before : undefined;
  for (const attempt of ['publish', 'same-state-replay']) {
    const result = spawnSync(join(env.RUNNER_TEMP, 'qa-cli/cadencr'), args, { stdio: 'inherit', env, timeout: 900000, killSignal: 'SIGKILL' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${attempt} failed`);
    const catalog = JSON.parse(readFileSync(join(state, 'catalog-publication-receipt.json')));
    const discovery = JSON.parse(readFileSync(join(state, 'discovery-receipt.json')));
    assert.equal(catalog.status, 'published_verified');
    assert.equal(discovery.status, 'discovery_verified');
    assert.equal(discovery.branch, 'marketplace-v2');
    if (env.PHASE === 'initial') {
      const mirror = JSON.parse(readFileSync(join(state, 'publications/001/mirror-receipt.json')));
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
    if (env.PHASE === 'renewal') assertEmptyDeltaRenewal(JSON.parse(readFileSync('requests/previous.json')), JSON.parse(bytes));
    const inventory = await remoteInventory();
    assertRetainedReleases(inventory);
    assertPreservedReleases(before, inventory);
    if (baseline) assert.deepEqual(inventory, baseline, 'replay changed remote IDs');
    baseline = inventory;
    const receipt = { attempt, request_sha256: env.REQUEST_SHA256, registry_commit: env.REVIEWED_COMMIT,
      repository: env.GITHUB_REPOSITORY, catalog, discovery, inventory };
    writeFileSync(join(root, `${attempt}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${env.PHASE}: ${attempt}\n\n- Request: \`${env.REQUEST_SHA256}\`\n- Commit: \`${env.REVIEWED_COMMIT}\`\n- Catalog/discovery receipts verified; see public diagnostic artifact.\n`);
  }
} finally {
  unlinkSync(key); // Only the task-owned secret, never state or a database.
}

async function remoteInventory() {
  const base = 'https://api.github.com/repos/merkr-software/cadencr-registry-qa';
  const headers = { Accept: 'application/vnd.github+json' }; // Anonymous; no host OAuth.
  const get = async path => JSON.parse(await boundedFetch(base + path, headers));
  const releases = await get('/releases?per_page=100');
  assert.ok(releases.length < 100, 'inventory must not silently truncate');
  for (const release of releases) {
    release.assets = await get(`/releases/${release.id}/assets?per_page=100`);
    assert.ok(release.assets.length < 100, 'assets inventory must not silently truncate');
  }
  const head = await get('/git/ref/heads/marketplace-v2');
  return { head: head.object.sha, releases: releases.map(r => ({ id: r.id, tag: r.tag_name, assets: r.assets.map(a => ({id:a.id,name:a.name,size:a.size})).sort((a,b)=>a.id-b.id) })).sort((a,b)=>a.id-b.id) };
}

function verifyIndex(index) {
  const result = spawnSync(join(env.RUNNER_TEMP, 'qa-cli/cadencr'), ['registry', 'verify-index', '--index', index, '--public-key', 'requests/public.pem', '--key-id', 'qa-2026'], { stdio: 'inherit', timeout: 60000, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'index signature verification failed');
}
