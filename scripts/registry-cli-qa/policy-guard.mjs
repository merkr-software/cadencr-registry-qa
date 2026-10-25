import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { file, local, sha, REPOSITORY } from "./guard.mjs";
export const REQUEST = "requests/stable-0152-20261025/policy.json";
export const KINDS = ["provider", "theme", "tab"];
const FILES = {
  provider: "managed-blocklist.json",
  theme: "managed-theme-blocklist.json",
  tab: "managed-tab-blocklist.json",
};
const WHOLE_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FOURTEEN_DAYS = 14 * 24 * 3600 * 1000;
// Reviewed, inert policies only: dates are committed bytes, never regenerated at runtime.
export function policyGuard(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, "1420296872");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.QA_DEFAULT_BRANCH, "main");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${REPOSITORY}/.github/workflows/policy.yml@refs/heads/main`,
  );
  assert.match(env.REVIEWED_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_COMMIT);
  assert.match(env.REQUEST_SHA256 ?? "", /^[a-f0-9]{64}$/);
  const requestBytes = file(local(REQUEST));
  assert.equal(sha(requestBytes), env.REQUEST_SHA256);
  const request = JSON.parse(requestBytes);
  assert.equal(request.schema_version, 1);
  assert.equal(request.repository, REPOSITORY);
  // Policy files live on a QA-only branch; never the production registry or an unreviewed branch.
  assert.ok(["marketplace-v2", "qa-policy-0152"].includes(request.discovery_branch));
  assert.match(request.key_id, /^[a-z0-9][a-z0-9-]{0,63}$/);
  const directory = dirname(REQUEST);
  const publicKey = local(join(directory, request.public_key));
  assert.equal(sha(file(publicKey, 16384)), request.public_key_sha256);
  assert.deepEqual(
    request.policies.map((p) => p.kind),
    KINDS,
  );
  assert.match(request.renewal_expires_at, WHOLE_SECOND);
  // The released CLI absorbs the raw CDN window itself: renewal follows bootstrap with no settle delay.
  assert.equal(request.cdn_settle_seconds, 0);
  const payloads = {};
  for (const policy of request.policies) {
    assert.equal(policy.file, FILES[policy.kind]);
    const path = local(join(directory, policy.payload));
    const bytes = file(path, 65536);
    assert.equal(sha(bytes), policy.payload_sha256);
    const payload = JSON.parse(bytes);
    assert.equal(payload.schema_version, 1);
    assert.deepEqual(payload.entries, [], "QA policies are inert: no revocation entries");
    for (const key of ["generated_at", "expires_at"]) assert.match(payload[key], WHOLE_SECOND);
    const generated = Date.parse(payload.generated_at);
    const expires = Date.parse(payload.expires_at);
    assert.ok(expires > generated && expires - generated <= FOURTEEN_DAYS);
    // The renewal expiry must outlive the bootstrap; the CLI itself bounds it to 14 days from its own clock.
    assert.ok(Date.parse(request.renewal_expires_at) > expires);
    assert.equal(payload.kind, policy.kind === "provider" ? undefined : `${policy.kind}-blocklist`);
    payloads[policy.kind] = { path, bytes, payload };
  }
  return { request, payloads, publicKey };
}
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === "--guard-only")
  policyGuard();
