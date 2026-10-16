import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(tmpdir(), 'qa-guard-test-'));
mkdirSync(join(root, 'requests'));
const request = { repository: 'merkr-software/cadencr-registry-qa', key_id: 'qa-2026', schema_version: 2,
  discovery_branch: 'marketplace-v2', public_key: 'public.pem', previous_index: 'bootstrap',
  publications: [{ submission: 'submission.json', registry_commit: '69b919e5f9e0162a55e10873e495829c05bcae13' }] };
const file = join(root, 'requests/initial.json');
const bytes = JSON.stringify(request);
writeFileSync(file, bytes);
const env = { ...process.env, GITHUB_REPOSITORY: request.repository, GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', QA_DEFAULT_BRANCH: 'main', QA_RUNNER: 'first',
  GITHUB_SHA: 'a'.repeat(40), REVIEWED_COMMIT: 'a'.repeat(40), PHASE: 'initial',
  REQUEST_SHA256: createHash('sha256').update(bytes).digest('hex') };
function run(patch) { return spawnSync(process.execPath, [new URL('./guard.mjs', import.meta.url).pathname], { cwd: root, env: { ...env, ...patch } }).status; }
assert.equal(run({}), 0);
for (const patch of [{ GITHUB_REPOSITORY: 'merkr-software/cadencr-registry' }, { GITHUB_EVENT_NAME: 'pull_request' },
  { REVIEWED_COMMIT: 'b'.repeat(40) }, { REVIEWED_COMMIT: 'a'.repeat(40) + '\n', GITHUB_SHA: 'a'.repeat(40) + '\n' },
  { REQUEST_SHA256: env.REQUEST_SHA256 + '\n' }, { GITHUB_REF: 'refs/heads/other' },
  { QA_DEFAULT_BRANCH: 'other' }, { QA_RUNNER: 'other' }, { PHASE: '../initial' }, { REQUEST_SHA256: '0'.repeat(64) }]) assert.notEqual(run(patch), 0);
request.publications = [{ submission: '../evil.json' }];
const bad = JSON.stringify(request);
writeFileSync(file, bad);
assert.notEqual(run({ REQUEST_SHA256: createHash('sha256').update(bad).digest('hex') }), 0);
console.log('Guard tests passed; task-owned diagnostic test scratch retained:', root);

for (const publications of [
  [{ submission: 'submission.json' }],
  [{ submission: 'submission.json', registry_commit: 'a'.repeat(40) }],
  [{ submission: 'submission.json', registry_commit: '69b919e5f9e0162a55e10873e495829c05bcae13', extra: true }],
]) {
  writeFileSync(file, JSON.stringify({ ...request, publications }));
  assert.notEqual(run({ REQUEST_SHA256: createHash('sha256').update(readFileSync(file)).digest('hex') }), 0);
}
