import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyGuard, REQUEST } from "./registry-cli-qa/policy-guard.mjs";
const repository = process.cwd();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Each case works in a scratch copy of the reviewed request directory, then returns.
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), "policy-guard-"));
  cpSync(join(repository, "requests/stable-0152-20261025"), join(directory, "requests/stable-0152-20261025"), {
    recursive: true,
  });
  return directory;
}
function environment(directory) {
  const requestSha = sha(readFileSync(join(directory, REQUEST)));
  return {
    GITHUB_REPOSITORY: "merkr-software/cadencr-registry-qa",
    GITHUB_REPOSITORY_ID: "1420296872",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    QA_DEFAULT_BRANCH: "main",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF:
      "merkr-software/cadencr-registry-qa/.github/workflows/policy.yml@refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    REVIEWED_COMMIT: "a".repeat(40),
    REQUEST_SHA256: requestSha,
  };
}
function inside(directory, operation) {
  process.chdir(directory);
  try {
    return operation();
  } finally {
    process.chdir(repository);
  }
}
test("policy guard accepts the exact reviewed inert request", () => {
  const directory = scratch();
  const { request, payloads } = inside(directory, () => policyGuard(environment(directory)));
  assert.deepEqual(Object.keys(payloads), ["provider", "theme", "tab"]);
  assert.equal(request.policies.length, 3);
});
test("policy guard rejects wrong commit, workflow, request digest and repository", () => {
  const directory = scratch();
  const good = environment(directory);
  for (const change of [
    { REVIEWED_COMMIT: "b".repeat(40) },
    { GITHUB_WORKFLOW_REF: good.GITHUB_WORKFLOW_REF.replace("policy.yml", "qa.yml") },
    { REQUEST_SHA256: "0".repeat(64) },
    { GITHUB_REPOSITORY: "merkr-software/cadencr-registry" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_EVENT_NAME: "push" },
  ])
    assert.throws(() => inside(directory, () => policyGuard({ ...good, ...change })));
});
test("policy guard rejects re-bound payloads, non-empty entries and over-long windows", () => {
  for (const mutate of [
    (p) => ({ ...p, entries: [{ provider_id: "x", reason: "r" }] }),
    (p) => ({ ...p, expires_at: "2026-11-30T17:30:00Z" }),
    (p) => ({ ...p, generated_at: "2026-10-25T17:30:00.000Z" }),
  ]) {
    const directory = scratch();
    const path = join(directory, "requests/stable-0152-20261025/provider-policy.json");
    const bytes = Buffer.from(JSON.stringify(mutate(JSON.parse(readFileSync(path)))));
    writeFileSync(path, bytes);
    // Re-bind the digest so the semantic checks, not the digest check, must reject the change.
    const requestPath = join(directory, REQUEST);
    const request = JSON.parse(readFileSync(requestPath));
    request.policies[0].payload_sha256 = sha(bytes);
    writeFileSync(requestPath, JSON.stringify(request));
    assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
  }
});
test("policy guard rejects an unreviewed discovery branch", () => {
  const directory = scratch();
  const path = join(directory, REQUEST);
  const request = JSON.parse(readFileSync(path));
  request.discovery_branch = "main";
  writeFileSync(path, JSON.stringify(request));
  assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
});
test("policy guard requires no settle delay between bootstrap and renewal", () => {
  for (const settle of [undefined, 1, 330]) {
    const directory = scratch();
    const path = join(directory, REQUEST);
    const request = JSON.parse(readFileSync(path));
    request.cdn_settle_seconds = settle;
    writeFileSync(path, JSON.stringify(request));
    assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
  }
});
test("policy guard rejects a renewal that does not outlive the bootstrap", () => {
  const directory = scratch();
  const path = join(directory, REQUEST);
  const request = JSON.parse(readFileSync(path));
  request.renewal_expires_at = "2026-10-30T00:00:00Z";
  writeFileSync(path, JSON.stringify(request));
  assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
});
