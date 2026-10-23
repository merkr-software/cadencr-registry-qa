import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { file, local, sha, VERSION, BINARY_SHA, REPOSITORY } from "./guard.mjs";
import {
  bytes,
  inventory,
  inventoryHash,
  childEnvironment,
  continuity,
  archiveCoverage,
  replayUnchanged,
  expectedDiscovery,
  failureDiagnostic,
} from "./evidence.mjs";

export const ORIGINAL_REQUEST = "b6201b5e76ad91fecee2c3c2629b518875d90f9f4e88b9035f263b4e3297b739";
export const OPERATION_COMMIT = "b63364e2f84e9e5e0cadbb05134d6b7db8a94854";
export const CATALOG_SHA = "9001895ef154cb0c312032b22dce73e593b8ac36a86924d5dee5224ab61fdb30";
export const ORIGINAL_PLAN = "9a3d0a2dc713a1cb2c5576e3e7db20436ed7917690e0b89eb06995147f727259";
export const GENERATED_AT = "2026-10-23T22:12:32Z";
export const EXPIRES_AT = "2026-10-30T22:12:32Z";
export const EXPECTED_INVENTORY =
  "9a61b85ebf21b741c68283a8f7bca2f32e6d639fe98d2cd08b40f54daa144f99";
export const EXPECTED_HEAD = "cf2cd4228df8c7321d913020f414163b44a848d5";
export const FAILED_RUN = 40032302758;
const HELPER_SHA = "57ff31556ee87708a8fcb197e635513e4ee3fc0013d91c1131fd0648836471ba";

export function bindIntent(plan, request, previous, candidate) {
  assert.equal(plan.operation_commit, OPERATION_COMMIT);
  assert.equal(plan.request_sha256, ORIGINAL_REQUEST);
  assert.equal(plan.expected_catalog_sha256, CATALOG_SHA);
  assert.equal(plan.original_plan_sha256, ORIGINAL_PLAN);
  assert.equal(plan.expected_inventory_sha256, EXPECTED_INVENTORY);
  assert.equal(plan.failed_run, FAILED_RUN);
  assert.equal(
    plan.previous_sha256,
    "73859a9154828f8d49d52f367960174adb7e166f8be3f0aa09432d59bc9a6187",
  );
  assert.equal(request.generated_at, GENERATED_AT);
  assert.equal(request.expires_at, EXPIRES_AT);
  assert.equal(request.repository, REPOSITORY);
  assert.equal(request.schema_version, 2);
  assert.equal(request.discovery_branch, "marketplace-v2");
  assert.equal(request.key_id, plan.key_id);
  assert.notEqual(request.previous_index, "bootstrap");
  assert.deepEqual(request.publications, []);
  if (candidate) {
    assert.equal(candidate.signed.schema_version, 2);
    assert.equal(candidate.signed.generated_at, request.generated_at);
    assert.equal(candidate.signed.expires_at, request.expires_at);
    continuity(previous, candidate, { phase: "renewal" });
    archiveCoverage(candidate, plan.archives);
    assert.equal(plan.archives.length, 21);
    assert.equal(candidate.signed.packages.length, 14);
  }
}

export function bindBytes(planBytes, planSha, requestBytes) {
  assert.equal(sha(planBytes), planSha);
  assert.equal(sha(requestBytes), ORIGINAL_REQUEST);
}

export function recoveryGuard(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, "1420296872");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.QA_DEFAULT_BRANCH, "main");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${REPOSITORY}/.github/workflows/recovery.yml@refs/heads/main`,
  );
  assert.match(env.REVIEWED_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_COMMIT);
  assert.match(env.PLAN_SHA256 ?? "", /^[a-f0-9]{64}$/);
  const planBytes = file(local(env.QA_PLAN));
  assert.equal(sha(planBytes), env.PLAN_SHA256);
  const plan = JSON.parse(planBytes);
  assert.equal(plan.phase, "renewal-recovery");
  const originalPlanBytes = file(local(plan.original_plan));
  assert.equal(sha(originalPlanBytes), ORIGINAL_PLAN);
  const originalPlan = JSON.parse(originalPlanBytes);
  assert.equal(originalPlan.phase, "renewal");
  assert.equal(originalPlan.request, plan.request);
  assert.equal(originalPlan.previous, plan.previous);
  assert.equal(originalPlan.previous_sha256, plan.previous_sha256);
  assert.equal(originalPlan.public_key, plan.public_key);
  assert.equal(originalPlan.public_key_sha256, plan.public_key_sha256);
  assert.deepEqual(originalPlan.archives, plan.archives);
  const requestBytes = file(local(plan.request));
  bindBytes(planBytes, env.PLAN_SHA256, requestBytes);
  assert.equal(sha(file(local(plan.previous))), plan.previous_sha256);
  assert.equal(sha(file(local(plan.public_key))), plan.public_key_sha256);
  for (const digest of [
    plan.previous_sha256,
    plan.public_key_sha256,
    plan.expected_inventory_sha256,
  ])
    assert.match(digest ?? "", /^[a-f0-9]{64}$/);
  const request = JSON.parse(requestBytes);
  assert.equal(resolve(plan.previous), resolve(dirname(plan.request), request.previous_index));
  assert.equal(resolve(plan.public_key), resolve(dirname(plan.request), request.public_key));
  const previous = JSON.parse(file(plan.previous));
  bindIntent(plan, request, previous);
  return { plan, request, previous };
}

export function sanitizedFailure(error) {
  return {
    status: "failed",
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code ?? "") ? error.code : "RECOVERY_CHECK_FAILED",
    child_status: Number.isInteger(error.childStatus) ? error.childStatus : null,
    diagnostic: error.diagnostic ? failureDiagnostic(error.diagnostic) : null,
    message_sha256: sha(Buffer.from(String(error.message ?? "failure"))),
  };
}

export function verifyBinary(binaryBytes, assertElf) {
  assert.equal(sha(binaryBytes), BINARY_SHA);
  assertElf(binaryBytes);
}

function execute(binary, args, env, authenticated = false, timeout = 900000) {
  const result = spawnSync(binary, args, {
    env: childEnvironment(env, authenticated),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1048576,
  });
  if (result.error || result.status !== 0) {
    const error = new Error("distributed recovery CLI failed");
    error.code = "RECOVERY_CLI_FAILED";
    error.childStatus = result.status;
    error.diagnostic = result;
    // Hash only; never expose untrusted child output, paths, URLs, or secret text.
    error.message = sha(Buffer.from(String(result.stderr ?? "") + String(result.stdout ?? "")));
    throw error;
  }
  return result.stdout;
}

async function observePublic(plan, baseline, expectedBytes, signal) {
  const observed = await inventory(process.env.CADENCR_REGISTRY_GITHUB_TOKEN, signal);
  assert.equal(inventoryHash(observed), plan.expected_inventory_sha256);
  replayUnchanged(observed, baseline);
  assert.equal(observed.discovery_sha256, CATALOG_SHA);
  assert.equal(observed.head, EXPECTED_HEAD);
  assert.equal(observed.releases.length, 42);
  const stable = `https://raw.githubusercontent.com/${REPOSITORY}/refs/heads/marketplace-v2/managed-index.json`;
  for (const url of [
    stable,
    `https://raw.githubusercontent.com/${REPOSITORY}/${observed.head}/managed-index.json`,
  ])
    assert.deepEqual(await bytes(url, {}, signal), expectedBytes);
  return observed;
}

async function publicArchives(candidate, plan, signal) {
  archiveCoverage(candidate, plan.archives);
  for (const archive of plan.archives) {
    const data = await bytes(archive.url, {}, signal);
    assert.equal(data.length, archive.size);
    assert.equal(sha(data), archive.sha256);
  }
}

export function bindFailedRun(run) {
  assert.equal(run.id, FAILED_RUN);
  assert.equal(run.repository.id, 1420296872);
  assert.equal(run.head_sha, OPERATION_COMMIT);
  assert.equal(run.head_branch, "main");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.path, ".github/workflows/qa.yml");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "failure");
}

async function admission(plan, request, previous, root, verify) {
  const signal = AbortSignal.timeout(60000);
  const failedRun = JSON.parse(
    await bytes(
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${FAILED_RUN}`,
      {},
      signal,
    ),
  );
  bindFailedRun(failedRun);
  const url = `https://github.com/${REPOSITORY}/releases/download/marketplace-v2-${CATALOG_SHA}/managed-index.json`;
  const data = await bytes(url, {}, signal);
  assert.equal(sha(data), CATALOG_SHA);
  const path = join(root, "candidate-verification.json");
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
  verify(plan.previous);
  verify(path);
  writeFileSync(join(root, "candidate-index.json"), data, { flag: "wx", mode: 0o600 });
  const candidate = JSON.parse(data);
  bindIntent(plan, request, previous, candidate);
  const before = await observePublic(plan, undefined, data, signal);
  await publicArchives(candidate, plan, signal);
  replayUnchanged(await inventory(process.env.CADENCR_REGISTRY_GITHUB_TOKEN, signal), before);
  return { data, candidate, before };
}

async function replay(context, attempt) {
  const { plan, env, state, args, binary, data, candidate, before, verify, root } = context;
  execute(binary, [...args, "--json"], env, true);
  const catalog = JSON.parse(file(join(state, "catalog-publication-receipt.json")));
  const discovery = JSON.parse(file(join(state, "discovery-receipt.json")));
  assert.equal(catalog.status, "published_verified");
  assert.equal(discovery.status, "discovery_verified");
  assert.equal(discovery.branch, "marketplace-v2");
  assert.equal(catalog.repository, REPOSITORY);
  assert.equal(catalog.registry_commit, OPERATION_COMMIT);
  assert.equal(catalog.tag_commit, OPERATION_COMMIT);
  assert.equal(catalog.catalog_sha256, CATALOG_SHA);
  assert.equal(
    catalog.catalog_url,
    `https://github.com/${REPOSITORY}/releases/download/marketplace-v2-${CATALOG_SHA}/managed-index.json`,
  );
  const signal = AbortSignal.timeout(60000);
  const publicBytes = await bytes(catalog.catalog_url, {}, signal);
  assert.equal(publicBytes.length, catalog.catalog_size);
  assert.deepEqual(publicBytes, data);
  const indexPath = join(root, `${attempt}-index.json`);
  writeFileSync(indexPath, publicBytes, { flag: "wx", mode: 0o600 });
  verify(indexPath);
  await publicArchives(candidate, plan, signal);
  const after = await observePublic(plan, before, data, signal);
  assert.ok(expectedDiscovery(after, discovery, CATALOG_SHA));
  assert.ok(after.releases.some((release) => release.id === catalog.release_id && !release.draft));
  writeFileSync(
    join(root, `${attempt}.json`),
    JSON.stringify({
      status: "verified",
      attempt,
      repository: REPOSITORY,
      request_sha256: ORIGINAL_REQUEST,
      plan_sha256: env.PLAN_SHA256,
      operation_commit: OPERATION_COMMIT,
      failed_run: FAILED_RUN,
      original_plan_sha256: ORIGINAL_PLAN,
      workflow_commit: env.REVIEWED_COMMIT,
      cli_sha256: BINARY_SHA,
      cli_version: VERSION,
      catalog_sha256: CATALOG_SHA,
      inventory_sha256: inventoryHash(after),
      discovery_head: after.head,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

export async function main(env = process.env) {
  const { plan, request, previous } = recoveryGuard(env);
  const binary = join(env.RUNNER_TEMP, "qa-cli/cadencr");
  assert.equal(sha(file("scripts/evidence.mjs")), HELPER_SHA);
  const { assertX8664Elf } = await import(pathToFileURL(resolve("scripts/evidence.mjs")));
  verifyBinary(file(binary, 256 * 1024 * 1024), assertX8664Elf);
  assert.equal(execute(binary, ["--version"], env, false, 30000), `cadencr ${VERSION}\n`);
  const verify = (path) =>
    execute(
      binary,
      [
        "registry",
        "verify-index",
        "--json",
        "--index",
        path,
        "--public-key",
        plan.public_key,
        "--key-id",
        plan.key_id,
      ],
      env,
      false,
      60000,
    );
  const root = join(env.RUNNER_TEMP, "qa-recovery-public");
  mkdirSync(root, { mode: 0o700 });
  let keyCreated = false;
  const key = join(env.RUNNER_TEMP, "qa-recovery-private.pem");
  try {
    const admitted = await admission(plan, request, previous, root, verify);
    const state = join(env.RUNNER_TEMP, "qa-recovery-state");
    mkdirSync(state, { mode: 0o700 });
    assert.ok(env.QA_SIGNING_KEY_PEM && Buffer.byteLength(env.QA_SIGNING_KEY_PEM) <= 16384);
    writeFileSync(key, env.QA_SIGNING_KEY_PEM, { flag: "wx", mode: 0o600 });
    keyCreated = true;
    delete env.QA_SIGNING_KEY_PEM;
    const args = [
      "registry",
      "publish-registry",
      "--request",
      plan.request,
      "--directory",
      state,
      "--repository",
      REPOSITORY,
      "--registry-commit",
      OPERATION_COMMIT,
      "--private-key",
      key,
      "--confirm-request-sha256",
      ORIGINAL_REQUEST,
    ];
    for (const attempt of ["fresh-recovery", "same-state-replay"])
      await replay({ ...admitted, plan, env, state, args, binary, verify, root }, attempt);
  } catch (error) {
    writeFileSync(join(root, "failure.json"), JSON.stringify(sanitizedFailure(error)) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    throw new Error("Recovery failed; inspect allowlisted failure proof");
  } finally {
    if (keyCreated) unlinkSync(key); // Only this exclusively created ephemeral key, never a DB.
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    if (process.argv.includes("--guard-only")) recoveryGuard();
    else await main();
  } catch (error) {
    process.stderr.write(JSON.stringify(sanitizedFailure(error)) + "\n");
    process.exitCode = 1;
  }
}
