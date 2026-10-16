import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const env = process.env;
assert.equal(env.GITHUB_REPOSITORY, 'merkr-software/cadencr-registry-qa');
assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(env.GITHUB_REF, 'refs/heads/main');
assert.equal(env.QA_DEFAULT_BRANCH, 'main');
assert.ok(['first', 'fresh'].includes(env.QA_RUNNER));
if (env.QA_RUNNER === 'fresh') assert.match(env.QA_EXPECTED_INVENTORY_SHA256 ?? '', /^[a-f0-9]{64}$(?![\s\S])/);
assert.match(env.REVIEWED_COMMIT ?? '', /^[a-f0-9]{40}$(?![\s\S])/);
assert.equal(env.GITHUB_SHA, env.REVIEWED_COMMIT);
assert.ok(['initial', 'renewal', 'fault'].includes(env.PHASE));
assert.match(env.REQUEST_SHA256 ?? '', /^[a-f0-9]{64}$(?![\s\S])/);
const path = `requests/${env.PHASE}.json`;
const stat = lstatSync(path);
assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1048576);
const bytes = readFileSync(path);
assert.equal(createHash('sha256').update(bytes).digest('hex'), env.REQUEST_SHA256);
const request = JSON.parse(bytes);
assert.equal(request.repository, env.GITHUB_REPOSITORY);
assert.equal(request.key_id, 'qa-2026');
assert.equal(request.schema_version, 2);
assert.equal(request.discovery_branch, 'marketplace-v2');
assert.equal(request.public_key, 'public.pem');
if (env.PHASE === 'initial') {
  assert.equal(request.previous_index, 'bootstrap');
  assert.deepEqual(request.publications, [{ submission: 'submission.json', registry_commit: '69b919e5f9e0162a55e10873e495829c05bcae13' }]);
} else if (env.PHASE === 'renewal') {
  assert.equal(request.previous_index, 'previous.json');
  assert.deepEqual(request.publications, []);
} else {
  assert.equal(request.previous_index, 'previous-fault.json');
  assert.deepEqual(request.publications, [{submission: 'submission-fault.json'}]);
}
console.log(`Verified ${env.PHASE} request ${env.REQUEST_SHA256} at ${env.REVIEWED_COMMIT}`);
