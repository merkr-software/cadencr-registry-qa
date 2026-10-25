import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { file, sha, VERSION, BINARY_SHA, REPOSITORY } from "./guard.mjs";
import { policyGuard, KINDS } from "./policy-guard.mjs";
import {
  bytes,
  inventory,
  preserved,
  childEnvironment,
  failureDiagnostic,
} from "./evidence.mjs";
const env = process.env;
const { request, payloads, publicKey } = policyGuard();
assert.equal(
  sha(file("scripts/evidence.mjs")),
  "57ff31556ee87708a8fcb197e635513e4ee3fc0013d91c1131fd0648836471ba",
);
const { assertX8664Elf } = await import(pathToFileURL(resolve("scripts/evidence.mjs")));
const binary = join(env.RUNNER_TEMP, "qa-cli/cadencr");
const binaryBytes = file(binary, 256 * 1024 * 1024);
assert.equal(sha(binaryBytes), BINARY_SHA);
assertX8664Elf(binaryBytes);
const BRANCH = request.discovery_branch;
const token = env.CADENCR_REGISTRY_GITHUB_TOKEN;
assert.ok(token, "job token required for policy publication");

function run(args, authenticated = false) {
  return spawnSync(binary, args[0] === "--version" ? args : ["--json", ...args], {
    env: childEnvironment(env, authenticated),
    encoding: "utf8",
    timeout: 300000,
    killSignal: "SIGKILL",
    maxBuffer: 1048576,
  });
}
function cli(args, authenticated = false) {
  const result = run(args, authenticated);
  assert.ok(
    !result.error && result.status === 0,
    `distributed CLI failed: ${JSON.stringify(failureDiagnostic(result))}`,
  );
  return result.stdout;
}
assert.equal(cli(["--version"]), `cadencr ${VERSION}\n`);

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60000),
  });
  if (response.status === 404) return null;
  assert.equal(response.status, 200);
  return response.json();
};
// Head commit plus blob and byte digest of every policy path, read through the API at that head.
async function branchState() {
  const head = (await api(`/git/ref/heads/${BRANCH}`)).object.sha;
  assert.match(head, /^[a-f0-9]{40}$/);
  const files = {};
  for (const policy of request.policies) {
    const content = await api(`/contents/${policy.file}?ref=${head}`);
    files[policy.kind] = content
      ? { blob: content.sha, sha256: sha(Buffer.from(content.content, "base64")) }
      : null;
  }
  return { head, files };
}
const publish = (kind, signed, flags, receipt) =>
  run(
    [
      "registry",
      "publish-policy",
      "--kind",
      kind,
      "--signed",
      signed,
      "--repository",
      REPOSITORY,
      "--discovery-branch",
      BRANCH,
      "--public-key",
      publicKey,
      "--key-id",
      request.key_id,
      ...flags,
      ...(receipt ? ["--receipt", receipt] : []),
    ],
    true,
  );
const verifyArgs = (kind, path) => [
  "registry",
  `verify-${kind}-blocklist`,
  "--index",
  path,
  "--public-key",
  publicKey,
  "--key-id",
  request.key_id,
];
const read = (path) => file(path, 1048576);
const json = (path) => JSON.parse(read(path));

const root = join(env.RUNNER_TEMP, "qa-policy-public");
const scratch = join(env.RUNNER_TEMP, "qa-policy-work");
const key = join(env.RUNNER_TEMP, "qa-policy-private.pem");
for (const dir of [root, scratch]) mkdirSync(dir, { mode: 0o700 });
assert.ok(env.QA_SIGNING_KEY_PEM && Buffer.byteLength(env.QA_SIGNING_KEY_PEM) <= 16384);
writeFileSync(key, env.QA_SIGNING_KEY_PEM, { flag: "wx", mode: 0o600 });
delete env.QA_SIGNING_KEY_PEM;
const proof = {
  repository: REPOSITORY,
  commit: env.REVIEWED_COMMIT,
  request_sha256: env.REQUEST_SHA256,
  cli_version: VERSION,
  cli_sha256: BINARY_SHA,
  discovery_branch: BRANCH,
  renewal_expires_at: request.renewal_expires_at,
  cdn_settle_seconds: request.cdn_settle_seconds,
  policies: {},
};
const fileOf = (kind, name) => join(scratch, `${kind}-${name}.json`);
const fields = (receipt) => ({
  outcome: receipt.outcome,
  status: receipt.status,
  sha256: receipt.sha256,
  size: receipt.size,
  blob_sha: receipt.blob_sha,
  generated_at: receipt.generated_at,
  expires_at: receipt.expires_at,
  previous_sha256: receipt.previous_sha256,
  url: receipt.url,
});
function checkReceipt(kind, receipt, outcome, digest) {
  assert.equal(receipt.outcome, outcome);
  assert.equal(receipt.kind, kind);
  assert.equal(receipt.repository, REPOSITORY);
  assert.equal(receipt.branch, BRANCH);
  assert.equal(receipt.sha256, digest);
  assert.match(receipt.blob_sha, /^[a-f0-9]{40}$/);
}
// Independent anonymous read of the public feed. The CLI has already verified it; this check only
// polls (read-only, bounded) until the raw CDN serves the expected bytes and records how long it took.
const publicWaits = [];
async function publicEquals(kind, phase, url, expected) {
  const started = Date.now();
  for (;;) {
    const observed = await bytes(
      url,
      { "Cache-Control": "no-cache", Pragma: "no-cache" },
      AbortSignal.timeout(30000),
    );
    if (observed.equals(expected)) {
      publicWaits.push({ kind, phase, waited_ms: Date.now() - started });
      return;
    }
    assert.ok(Date.now() - started < 360000, `${kind} public feed did not converge`);
    await delay(2000);
  }
}
const timings = [];
const publishOk = (kind, signed, flags, receiptPath) => {
  const started = Date.now();
  const result = publish(kind, signed, flags, receiptPath);
  timings.push({ kind, mode: flags[0] ?? "plain", elapsed_ms: Date.now() - started });
  assert.ok(
    !result.error && result.status === 0,
    `${kind} publish-policy failed: ${JSON.stringify(failureDiagnostic(result))}`,
  );
  return json(receiptPath);
};
// A refused publication must exit nonzero with the expected closed diagnostic and write nothing.
function refused(kind, signed, flags, expected) {
  const result = publish(kind, signed, flags);
  assert.ok(!result.error && result.status !== 0, `${kind} publish-policy was not refused`);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "REGISTRY_POLICY_PUBLICATION_FAILED");
  assert.ok(failure.message.includes(expected), `${kind} refusal reason differs`);
  return { ...failureDiagnostic(result), expected_reason: expected };
}
try {
  const initial = await branchState();
  const inventoryBefore = await inventory(token);
  for (const kind of KINDS)
    assert.equal(initial.files[kind], null, `${kind} policy already exists; bootstrap refused`);
  proof.initial = initial;
  for (const kind of KINDS) proof.policies[kind] = {};

  // 1. Sign inert empty-entries policies; 2. verify them.
  for (const kind of KINDS) {
    const signed = fileOf(kind, "bootstrap");
    cli([
      "registry",
      `sign-${kind}-blocklist`,
      "--payload",
      payloads[kind].path,
      "--private-key",
      key,
      "--key-id",
      request.key_id,
      "--output",
      signed,
    ]);
    cli(verifyArgs(kind, signed));
    const envelope = json(signed);
    assert.deepEqual(envelope.signed.entries, []);
    assert.equal(envelope.signed.generated_at, payloads[kind].payload.generated_at);
    assert.equal(envelope.signed.expires_at, payloads[kind].payload.expires_at);
    proof.policies[kind].signed_sha256 = sha(read(signed));
    writeFileSync(join(root, `${kind}-bootstrap.json`), read(signed), { flag: "wx" });
  }
  // 3. Bootstrap publication, then the published bytes through API and anonymous raw read.
  for (const kind of KINDS) {
    const signed = fileOf(kind, "bootstrap");
    const receipt = publishOk(kind, signed, ["--bootstrap"], fileOf(kind, "bootstrap-receipt"));
    checkReceipt(kind, receipt, "bootstrapped", sha(read(signed)));
    assert.equal(receipt.previous_sha256, null);
    await publicEquals(kind, "bootstrap", receipt.url, read(signed));
    proof.policies[kind].bootstrap = fields(receipt);
  }
  const bootstrapped = await branchState();
  for (const kind of KINDS)
    assert.equal(bootstrapped.files[kind].sha256, proof.policies[kind].signed_sha256);
  proof.after_bootstrap = bootstrapped;

  // 4. Renew from the authenticated fetch-policy baseline.
  for (const kind of KINDS) {
    const baseline = fileOf(kind, "baseline");
    cli(
      [
        "registry",
        "fetch-policy",
        "--kind",
        kind,
        "--repository",
        REPOSITORY,
        "--discovery-branch",
        BRANCH,
        "--output",
        baseline,
      ],
      true,
    );
    assert.deepEqual(read(baseline), read(fileOf(kind, "bootstrap")));
    cli(verifyArgs(kind, baseline));
    const renewed = fileOf(kind, "renewed");
    cli([
      "registry",
      "renew-policy",
      "--kind",
      kind,
      "--current",
      baseline,
      "--public-key",
      publicKey,
      "--key-id",
      request.key_id,
      "--private-key",
      key,
      "--expires-at",
      request.renewal_expires_at,
      "--output",
      renewed,
    ]);
    cli(verifyArgs(kind, renewed));
    const before = json(baseline).signed;
    const after = json(renewed).signed;
    assert.deepEqual(after.entries, before.entries);
    assert.ok(Date.parse(after.generated_at) > Date.parse(before.generated_at));
    assert.equal(after.expires_at, request.renewal_expires_at);
    assert.notEqual(sha(read(renewed)), sha(read(baseline)));
    proof.policies[kind].baseline_sha256 = sha(read(baseline));
    proof.policies[kind].renewed_sha256 = sha(read(renewed));
    proof.policies[kind].renewed_generated_at = after.generated_at;
    writeFileSync(join(root, `${kind}-renewed.json`), read(renewed), { flag: "wx" });
  }
  // 5. Publish the renewals; 6. replay is idempotent.
  for (const kind of KINDS) {
    const renewed = fileOf(kind, "renewed");
    const digest = sha(read(renewed));
    const receipt = publishOk(kind, renewed, ["--renewal"], fileOf(kind, "renewal-receipt"));
    checkReceipt(kind, receipt, "advanced", digest);
    assert.equal(receipt.previous_sha256, proof.policies[kind].signed_sha256);
    await publicEquals(kind, "renewal", receipt.url, read(renewed));
    proof.policies[kind].renewal = fields(receipt);
  }
  const renewedState = await branchState();
  for (const kind of KINDS)
    assert.equal(renewedState.files[kind].sha256, proof.policies[kind].renewed_sha256);
  proof.after_renewal = renewedState;
  for (const kind of KINDS) {
    const renewed = fileOf(kind, "renewed");
    const receipt = publishOk(kind, renewed, ["--renewal"], fileOf(kind, "replay-receipt"));
    checkReceipt(kind, receipt, "unchanged", sha(read(renewed)));
    assert.equal(receipt.blob_sha, renewedState.files[kind].blob);
    proof.policies[kind].replay = fields(receipt);
  }
  const replayed = await branchState();
  assert.deepEqual(replayed, renewedState, "replay wrote to the discovery branch");
  proof.after_replay = replayed;

  // 7. Rollback: republishing the older bootstrap policy is refused and nothing is written.
  for (const kind of KINDS) {
    const older = fileOf(kind, "bootstrap");
    const plain = refused(kind, older, [], "rollback refused");
    const stale = refused(kind, older, ["--renewal"], "rollback refused");
    const state = await branchState();
    assert.deepEqual(state, renewedState, `${kind} rollback attempt wrote to the branch`);
    proof.policies[kind].rollback = { plain, renewal_flag: stale };
  }
  proof.after_rollback = await branchState();
  assert.deepEqual(proof.after_rollback, renewedState);
  for (const kind of KINDS) {
    const fetched = fileOf(kind, "final");
    cli(
      [
        "registry",
        "fetch-policy",
        "--kind",
        kind,
        "--repository",
        REPOSITORY,
        "--discovery-branch",
        BRANCH,
        "--output",
        fetched,
      ],
      true,
    );
    assert.deepEqual(read(fetched), read(fileOf(kind, "renewed")));
    cli(verifyArgs(kind, fetched));
    proof.policies[kind].final_sha256 = sha(read(fetched));
  }
  const inventoryAfter = await inventory(token);
  preserved(inventoryBefore.releases, inventoryAfter.releases);
  assert.equal(inventoryBefore.releases.length, inventoryAfter.releases.length);
  assert.equal(inventoryBefore.discovery_sha256, inventoryAfter.discovery_sha256);
  proof.catalog_unchanged = { discovery_sha256: inventoryAfter.discovery_sha256 };
  proof.releases_unchanged = inventoryAfter.releases.length;
  proof.publish_elapsed_ms = timings;
  proof.independent_public_read_wait_ms = publicWaits;
  // Strict allowlist: no environment, private state, raw CLI output or unknown receipt fields.
  writeFileSync(join(root, "policy-proof.json"), JSON.stringify(proof) + "\n", { flag: "wx" });
} catch (error) {
  // Sanitized failure record only: message text may quote untrusted child or API output.
  writeFileSync(
    join(root, "policy-failure.json"),
    JSON.stringify({
      status: "failed",
      message_sha256: sha(Buffer.from(String(error?.message ?? "failure"))),
    }) + "\n",
    { flag: "wx" },
  );
  throw error;
} finally {
  unlinkSync(key); // Only this invocation's exclusively-created signing key; never a database.
}
