// Run locally BEFORE review/commit, never from the secret-bearing workflow.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const [sourceCommit, sourceTag] = process.argv.slice(2);
assert.match(sourceCommit ?? '', /^[a-f0-9]{40}$/);
assert.match(sourceTag ?? '', /^qa-source-[A-Za-z0-9._-]+$/);
const repository = 'merkr-software/cadencr-registry-qa';
const archive = readFileSync('fixtures/theme.tar.gz');
const submission = { schema_version: 2, package: { kind: 'theme', package: {
  theme: { id: 'qa-inert-theme', name: 'QA inert', description: 'Inert public QA fixture',
    version: '0.0.1', repository: `https://github.com/${repository}`, license: 'Apache-2.0',
    document_version: 1, distribution: {
      archive: `https://github.com/${repository}/releases/download/${sourceTag}/theme.tar.gz`,
      sha256: createHash('sha256').update(archive).digest('hex') } },
  host: { publisher: 'merkr-software', compatibility: { min_app_version: '0.13.0' } }
} }, source: { repository: `https://github.com/${repository}`, commit: sourceCommit, tag: sourceTag },
changelog: 'Inert public QA fixture' };
const now = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
const request = { schema_version: 2, repository, key_id: 'qa-2026', discovery_branch: 'marketplace-v2',
  generated_at: now.toISOString().replace('.000Z', 'Z'),
  expires_at: new Date(+now + 7 * 86400000).toISOString().replace('.000Z', 'Z'),
  previous_index: 'bootstrap', public_key: 'public.pem', publications: [{ submission: 'submission.json' }] };
for (const [file, value] of [['submission.json', submission], ['initial.json', request]]) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(`requests/${file}`, bytes, { flag: 'wx' });
  console.log(`${file}: ${createHash('sha256').update(bytes).digest('hex')}`);
}
