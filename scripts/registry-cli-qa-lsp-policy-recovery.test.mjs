import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha, REPOSITORY } from "./registry-cli-qa/guard.mjs";
import {
  INCIDENT,
  FILES,
  DIGESTS,
  CONFIG,
  bindRun,
  bindDocuments,
  recoveryGuard,
} from "./registry-cli-qa/lsp-policy-recovery-guard.mjs";
import {
  bindPolicy,
  publicationArgs,
  cli,
  ROLLBACK_MESSAGE,
  PUBLIC_POLICY,
  POLICY_TIMEOUT_MS,
} from "./registry-cli-qa/lsp-policy-recovery-client.mjs";
import { recover, checkReceipt, safeFailure } from "./registry-cli-qa/lsp-policy-recovery.mjs";

const repositoryRoot = process.cwd();
const raw = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, readFileSync(path)]),
);
function context() {
  return {
    ...bindDocuments(raw),
    raw,
    files: Object.fromEntries(
      Object.entries(FILES).map(([key, path]) => [key, join(repositoryRoot, path)]),
    ),
    config_sha256: "a".repeat(64),
  };
}
function run(baseline = false) {
  return {
    id: baseline ? INCIDENT.baseline_run : INCIDENT.failed_run,
    run_attempt: 1,
    repository: { id: 1420296872 },
    head_repository: { id: 1420296872 },
    head_sha: INCIDENT.operation_commit,
    head_branch: "main",
    event: "workflow_dispatch",
    path: `.github/workflows/${baseline ? "qa" : "policy"}.yml`,
    status: "completed",
    conclusion: baseline ? "success" : "failure",
  };
}
function receipt() {
  return {
    schema_version: 1,
    status: "policy_verified",
    outcome: "unchanged",
    kind: "lsp",
    repository: REPOSITORY,
    branch: INCIDENT.branch,
    url: PUBLIC_POLICY,
    sha256: DIGESTS.renewed,
    size: raw.renewed.length,
    blob_sha: INCIDENT.policy_blob,
    generated_at: INCIDENT.renewed_generated_at,
    expires_at: INCIDENT.renewed_expires_at,
    previous_sha256: null,
  };
}

test("incident binds every original raw input and preserves the failed outcome", () => {
  context();
  for (const key of Object.keys(FILES))
    assert.throws(() =>
      bindDocuments({ ...raw, [key]: Buffer.concat([raw[key], Buffer.from(" ")]) }),
    );
  bindRun(run());
  bindRun(run(true), true);
  for (const change of [
    { id: INCIDENT.failed_run + 1 },
    { run_attempt: 2 },
    { head_sha: "b".repeat(40) },
    { conclusion: "success" },
    { status: "in_progress" },
    { path: ".github/workflows/qa.yml" },
    { head_branch: "other" },
    { repository: { id: 1 } },
    { head_repository: { id: 1 } },
  ])
    assert.throws(() => bindRun({ ...run(), ...change }));
});

test("recovery guard requires exact QA delivery, closed config and immutable raw copies", () => {
  const directory = mkdtempSync(join(tmpdir(), "lsp-policy-recovery-guard-"));
  for (const [key, path] of Object.entries(FILES)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), raw[key]);
  }
  const config = {
    schema_version: 1,
    failed_run: INCIDENT.failed_run,
    operation_commit: INCIDENT.operation_commit,
    files: FILES,
  };
  const configBytes = JSON.stringify(config);
  writeFileSync(join(directory, CONFIG), configBytes);
  const env = {
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REPOSITORY_ID: "1420296872",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/lsp-policy-recovery.yml@refs/heads/main`,
    GITHUB_SHA: "a".repeat(40),
    REVIEWED_COMMIT: "a".repeat(40),
    CONFIG_SHA256: sha(Buffer.from(configBytes)),
  };
  process.chdir(directory);
  try {
    recoveryGuard(env);
    for (const change of [
      { GITHUB_REPOSITORY: "other/repo" },
      { GITHUB_REPOSITORY_ID: "1" },
      { GITHUB_REF: "refs/heads/other" },
      { GITHUB_EVENT_NAME: "push" },
      { REVIEWED_COMMIT: "b".repeat(40) },
      { CONFIG_SHA256: "0".repeat(64) },
      { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace("lsp-policy-recovery", "policy") },
    ])
      assert.throws(() => recoveryGuard({ ...env, ...change }));
    writeFileSync(CONFIG, JSON.stringify({ ...config, private_key: "/private/forbidden" }));
    assert.throws(() => recoveryGuard({ ...env, CONFIG_SHA256: sha(readFileSync(CONFIG)) }));
    writeFileSync(CONFIG, configBytes);
    writeFileSync(FILES.renewed, raw.bootstrap);
    assert.throws(() => recoveryGuard(env));
  } finally {
    process.chdir(repositoryRoot);
  }
});

test("admission requires identical already-live bytes, blob and branch head", () => {
  const head = { object: { sha: INCIDENT.policy_head } };
  const content = {
    type: "file",
    encoding: "base64",
    sha: INCIDENT.policy_blob,
    size: raw.renewed.length,
    content: raw.renewed.toString("base64"),
  };
  const state = bindPolicy(head, content, raw.renewed);
  assert.equal(state.sha256, DIGESTS.renewed);
  assert.throws(() => bindPolicy({ object: { sha: "c".repeat(40) } }, content, raw.renewed));
  for (const change of [
    { sha: "d".repeat(40) },
    { content: raw.bootstrap.toString("base64") },
    { size: 1 },
    { encoding: "utf8" },
  ])
    assert.throws(() => bindPolicy(head, { ...content, ...change }, raw.renewed));
});

test("only exact unchanged replay receipts qualify, without copying unknown fields", () => {
  const expected = receipt();
  assert.deepEqual(
    checkReceipt({ ...expected, private_path: "/private/hidden" }, context()),
    expected,
  );
  for (const change of [
    { outcome: "advanced" },
    { status: "draft_verified" },
    { previous_sha256: DIGESTS.bootstrap },
    { blob_sha: "d".repeat(40) },
    { sha256: DIGESTS.bootstrap },
    { generated_at: "new" },
    { branch: "main" },
  ])
    assert.throws(() => checkReceipt({ ...expected, ...change }, context()));
});

test("CLI requests are replay-only, receive no signing key and wait beyond the CLI public budget", () => {
  assert.equal(POLICY_TIMEOUT_MS, 900000);
  const ctx = context();
  const calls = [];
  let result = { status: 0, stdout: "", stderr: "" };
  const client = cli(
    "/reviewed/elf",
    {
      PATH: "/bin",
      CADENCR_REGISTRY_GITHUB_TOKEN: "synthetic-token",
      QA_SIGNING_KEY_PEM: "synthetic-private-key",
      GH_TOKEN: "ambient",
    },
    (_binary, args, options) => {
      calls.push({ args, options });
      return result;
    },
  );
  client.verify(ctx.files.renewed, ctx.files.public_key);
  client.replay(ctx, "/scratch/receipt");
  client.fetch(ctx, "/scratch/fetched");
  result = {
    status: 1,
    stdout: "",
    stderr: JSON.stringify({
      ok: false,
      code: "REGISTRY_POLICY_PUBLICATION_FAILED",
      message: ROLLBACK_MESSAGE,
    }),
  };
  client.rejectOlder(ctx, false);
  client.rejectOlder(ctx, true);
  for (const call of calls) {
    assert.equal(call.options.timeout, 900000);
    assert.ok(!call.args.includes("--bootstrap") && !call.args.includes("--private-key"));
    assert.ok(!JSON.stringify(call).includes("synthetic-private-key"));
  }
  assert.equal(calls[0].options.env.CADENCR_REGISTRY_GITHUB_TOKEN, undefined);
  assert.equal(calls[1].options.env.CADENCR_REGISTRY_GITHUB_TOKEN, "synthetic-token");
  assert.ok(publicationArgs(ctx).includes(ctx.files.renewed));
  for (const bad of [
    { ...result, status: 2 },
    { ...result, status: null, error: { code: "ETIMEDOUT" } },
    { ...result, stderr: JSON.stringify({ ok: false, code: "OTHER", message: ROLLBACK_MESSAGE }) },
  ]) {
    result = bad;
    assert.throws(() => client.rejectOlder(ctx, true));
  }
});

async function simulate({
  failAdmission = false,
  failObservation = 0,
  changedReceipt = false,
  changedFetch = false,
} = {}) {
  const ctx = context();
  const directory = mkdtempSync(join(tmpdir(), "lsp-policy-replay-test-"));
  const publicRoot = join(directory, "public"),
    workRoot = join(directory, "work");
  mkdirSync(publicRoot);
  mkdirSync(workRoot);
  const trace = [];
  const state = {
    head: INCIDENT.policy_head,
    blob: INCIDENT.policy_blob,
    sha256: DIGESTS.renewed,
    size: raw.renewed.length,
  };
  let observations = 0;
  const client = {
    verifyBinary: () => trace.push("verify-binary"),
    verify: () => trace.push("verify"),
    replay(_context, path) {
      trace.push("replay");
      writeFileSync(
        path,
        JSON.stringify({ ...receipt(), ...(changedReceipt ? { outcome: "advanced" } : {}) }),
      );
    },
    fetch(_context, path) {
      trace.push("fetch");
      writeFileSync(path, changedFetch ? raw.bootstrap : raw.renewed);
    },
    rejectOlder(_context, renewal) {
      trace.push(renewal ? "rollback-renewal" : "rollback-plain");
      return { code: "REGISTRY_POLICY_PUBLICATION_FAILED", reason: "rollback_refused" };
    },
  };
  const transport = {
    async admit() {
      trace.push("admit");
      if (failAdmission) throw new Error("wrong original run");
    },
    async observe() {
      trace.push("observe");
      if (++observations === failObservation) throw new Error("inventory drift");
      return state;
    },
    async publicPolicy(value) {
      trace.push("public");
      assert.deepEqual(value, raw.renewed);
    },
  };
  try {
    const proof = await recover(ctx, {
      client,
      transport,
      publicRoot,
      workRoot,
      reviewedCommit: "a".repeat(40),
    });
    return { proof, trace, directory };
  } catch (error) {
    return { error, trace, directory };
  }
}

test("fresh reconstruction and same-state replay preserve policy and full registry inventory", async () => {
  const { proof, trace, directory } = await simulate();
  assert.equal(proof.status, "verified");
  assert.equal(proof.original_conclusion, "failure");
  assert.equal(proof.original_cause, "not_established");
  assert.equal(proof.attempts.length, 2);
  assert.equal(trace.filter((name) => name === "replay").length, 2);
  assert.equal(trace.filter((name) => name === "observe").length, 5);
  assert.equal(proof.rollback.length, 2);
  assert.equal(proof.releases_preserved, 80);
  assert.equal(proof.signing_performed, false);
  assert.ok(!JSON.stringify(proof).includes(directory));
});

test("admission, inventory, receipt and fetched-byte drift never produce qualified evidence", async () => {
  for (const options of [
    { failAdmission: true },
    { failObservation: 1 },
    { failObservation: 2 },
    { changedReceipt: true },
    { changedFetch: true },
  ]) {
    const result = await simulate(options);
    assert.ok(result.error);
    assert.equal(result.proof, undefined);
    if (options.failAdmission || options.failObservation === 1)
      assert.ok(!result.trace.includes("replay"));
  }
});

test("failure records never retain raw messages, paths, credentials or unknown diagnostics", () => {
  const secret = "synthetic-secret /private/scratch";
  const error = new Error(secret);
  error.diagnostic = {
    exit_status: 1,
    signal: "SIGKILL",
    process_error: "ETIMEDOUT",
    cli_code: secret,
    raw_output: secret,
  };
  const safe = safeFailure(error);
  assert.ok(!JSON.stringify(safe).includes(secret));
  assert.equal(safe.process_error, "ETIMEDOUT");
  assert.equal(safe.cli_code, null);
  assert.match(safe.message_sha256, /^[a-f0-9]{64}$/);
});
