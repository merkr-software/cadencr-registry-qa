import assert from "node:assert/strict";
import test from "node:test";
import {
  bindIntent,
  bindBytes,
  bindFailedRun,
  recoveryGuard,
  sanitizedFailure,
  verifyBinary,
  ORIGINAL_REQUEST,
  OPERATION_COMMIT,
  CATALOG_SHA,
  ORIGINAL_PLAN,
  GENERATED_AT,
  EXPIRES_AT,
  EXPECTED_INVENTORY,
  FAILED_RUN,
} from "./registry-cli-qa/recovery.mjs";
import { REPOSITORY, BINARY_SHA, sha } from "./registry-cli-qa/guard.mjs";
import { replayUnchanged, childEnvironment } from "./registry-cli-qa/evidence.mjs";

const plan = () => ({
  operation_commit: OPERATION_COMMIT,
  request_sha256: ORIGINAL_REQUEST,
  expected_catalog_sha256: CATALOG_SHA,
  key_id: "qa-2026",
  original_plan_sha256: ORIGINAL_PLAN,
  expected_inventory_sha256: EXPECTED_INVENTORY,
  failed_run: FAILED_RUN,
  previous_sha256: "73859a9154828f8d49d52f367960174adb7e166f8be3f0aa09432d59bc9a6187",
});
const request = () => ({
  repository: REPOSITORY,
  schema_version: 2,
  discovery_branch: "marketplace-v2",
  key_id: "qa-2026",
  previous_index: "previous.json",
  publications: [],
  generated_at: GENERATED_AT,
  expires_at: EXPIRES_AT,
});
const env = () => ({
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REPOSITORY_ID: "1420296872",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  QA_DEFAULT_BRANCH: "main",
  GITHUB_REF: "refs/heads/main",
  REVIEWED_COMMIT: "a".repeat(40),
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/recovery.yml@refs/heads/main`,
  PLAN_SHA256: "b".repeat(64),
  QA_PLAN: "missing-reviewed-plan.json",
});

test("recovery guard rejects non-QA repository, workflow, ref and unreviewed commit before input reads", () => {
  for (const patch of [
    { GITHUB_REPOSITORY: "merkr-software/cadencr-registry" },
    { GITHUB_REPOSITORY_ID: "1" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/qa.yml@refs/heads/main` },
    { GITHUB_REF: "refs/heads/other" },
    { QA_DEFAULT_BRANCH: "other" },
    { GITHUB_SHA: "c".repeat(40) },
    { PLAN_SHA256: "unreviewed" },
  ])
    assert.throws(() => recoveryGuard({ ...env(), ...patch }), assert.AssertionError);
});

test("recovery binds original request and operation, not workflow delivery commit", () => {
  bindIntent(plan(), request(), undefined);
  for (const patch of [
    { operation_commit: "a".repeat(40) },
    { request_sha256: "f".repeat(64) },
    { expected_catalog_sha256: "e".repeat(64) },
    { original_plan_sha256: "e".repeat(64) },
    { expected_inventory_sha256: "e".repeat(64) },
    { failed_run: 1 },
  ])
    assert.throws(() => bindIntent({ ...plan(), ...patch }, request(), undefined));
  for (const patch of [
    { publications: [{ submission: "new.json" }] },
    { previous_index: "bootstrap" },
    { discovery_branch: "main" },
    { schema_version: 1 },
    { generated_at: "2026-10-24T00:00:00Z" },
    { expires_at: "2026-10-31T00:00:00Z" },
  ])
    assert.throws(() => bindIntent(plan(), { ...request(), ...patch }, undefined));
});

test("candidate must preserve original dates and empty-delta packages", () => {
  const req = {
    ...request(),
    generated_at: GENERATED_AT,
    expires_at: EXPIRES_AT,
  };
  const prior = {
    signed: {
      generated_at: "2026-10-17T01:00:00Z",
      expires_at: "2026-10-24T01:00:00Z",
      packages: [],
    },
  };
  const candidate = {
    signed: {
      schema_version: 2,
      generated_at: req.generated_at,
      expires_at: req.expires_at,
      packages: [],
    },
  };
  // This synthetic fixture deliberately has no twenty-one archives: admission must still fail closed.
  assert.throws(() => bindIntent({ ...plan(), archives: [] }, req, prior, candidate));
  assert.throws(() =>
    bindIntent(plan(), req, prior, {
      signed: { ...candidate.signed, generated_at: "2026-10-19T00:00:00Z" },
    }),
  );
});

test("recovery authenticates the original failed run rather than accepting successful or unrelated runs", () => {
  const run = {
    id: FAILED_RUN,
    repository: { id: 1420296872 },
    head_sha: OPERATION_COMMIT,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/qa.yml",
    status: "completed",
    conclusion: "failure",
  };
  bindFailedRun(run);
  for (const patch of [
    { conclusion: "success" },
    { id: 1 },
    { head_sha: "a".repeat(40) },
    { path: ".github/workflows/recovery.yml" },
    { event: "push" },
  ])
    assert.throws(() => bindFailedRun({ ...run, ...patch }));
});

test("full inventory equality includes discovery, releases and asset identities", () => {
  const before = { head: "a", blob: "b", releases: [{ id: 1, assets: [{ id: 2, size: 3 }] }] };
  replayUnchanged(structuredClone(before), before);
  for (const after of [
    { ...before, head: "changed" },
    { ...before, blob: "changed" },
    { ...before, releases: [] },
    { ...before, releases: [{ id: 1, assets: [{ id: 4, size: 3 }] }] },
  ])
    assert.throws(() => replayUnchanged(after, before));
});

test("wrong distributed binary digest never reaches ELF check", () => {
  let called = false;
  assert.equal(BINARY_SHA.length, 64);
  assert.throws(() =>
    verifyBinary(Buffer.from("substitute"), () => {
      called = true;
    }),
  );
  assert.equal(called, false);
});

test("failures expose allowlisted status and hashes, never raw output or secrets", () => {
  const secret = "PRIVATE-KEY-CONTENT token-sensitive";
  const error = new Error(secret);
  error.code = secret;
  error.stdout = secret;
  error.diagnostic = { status: 1, stderr: secret, stdout: secret, env: { SECRET: secret } };
  const proof = sanitizedFailure(error);
  assert.equal(proof.code, "RECOVERY_CHECK_FAILED");
  assert.match(proof.message_sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(proof).includes(secret));
  const clean = childEnvironment(
    {
      HOME: "/tmp/qa",
      QA_SIGNING_KEY_PEM: secret,
      CADENCR_REGISTRY_GITHUB_TOKEN: secret,
      GITHUB_TOKEN: secret,
    },
    false,
  );
  assert.deepEqual(clean, { HOME: "/tmp/qa" });
  assert.deepEqual(
    childEnvironment(
      { QA_SIGNING_KEY_PEM: secret, CADENCR_REGISTRY_GITHUB_TOKEN: "job-token" },
      true,
    ),
    { CADENCR_REGISTRY_GITHUB_TOKEN: "job-token" },
  );
});

test("reviewed plan hash and original request byte changes fail closed", () => {
  const planBytes = Buffer.from("reviewed plan");
  assert.throws(() => bindBytes(planBytes, "0".repeat(64), Buffer.from("changed request")));
  assert.throws(() => bindBytes(planBytes, sha(planBytes), Buffer.from("changed request")));
});

test("authenticated-candidate intent accepts exact renewal and rejects package or date drift", () => {
  const packages = Array.from({ length: 14 }, (_, index) => ({
    kind: "theme",
    package: {
      theme: {
        id: `synthetic-${index}`,
        distribution: {
          archive: `https://github.com/${REPOSITORY}/releases/download/synthetic-${index}/theme.tar.gz`,
          sha256: String(index).repeat(64),
        },
      },
    },
  }));
  for (let index = 0; index < 7; index++) {
    const distribution = packages[index].package.theme.distribution;
    packages[index] = {
      kind: "provider",
      package: {
        agent: {
          distribution: {
            binary: {
              linux: distribution,
              darwin: { ...distribution, archive: distribution.archive + "-darwin" },
            },
          },
        },
      },
    };
  }
  const distributions = packages.flatMap((entry) =>
    entry.kind === "provider"
      ? Object.values(entry.package.agent.distribution.binary)
      : [entry.package.theme.distribution],
  );
  const reviewed = {
    ...plan(),
    archives: distributions.map((distribution) => ({
      url: distribution.archive,
      sha256: distribution.sha256,
      size: 1,
    })),
  };
  const req = {
    ...request(),
    generated_at: GENERATED_AT,
    expires_at: EXPIRES_AT,
  };
  const previous = {
    signed: { packages, generated_at: "2026-10-17T01:00:00Z", expires_at: "2026-10-24T01:00:00Z" },
  };
  const candidate = {
    signed: {
      packages,
      schema_version: 2,
      generated_at: req.generated_at,
      expires_at: req.expires_at,
    },
  };
  bindIntent(reviewed, req, previous, candidate);
  assert.equal(reviewed.archives.length, 21);
  assert.throws(() =>
    bindIntent({ ...reviewed, archives: reviewed.archives.slice(1) }, req, previous, candidate),
  );
  for (const patch of [{ packages: packages.slice(1) }, { expires_at: "2026-10-26T01:00:00Z" }])
    assert.throws(() =>
      bindIntent(reviewed, req, previous, { signed: { ...candidate.signed, ...patch } }),
    );
});
