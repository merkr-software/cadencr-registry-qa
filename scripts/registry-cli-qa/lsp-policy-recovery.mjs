import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { file, sha, REPOSITORY } from "./guard.mjs";
import { recoveryGuard, INCIDENT, DIGESTS } from "./lsp-policy-recovery-guard.mjs";
import { network, cli, PUBLIC_POLICY } from "./lsp-policy-recovery-client.mjs";

export function checkReceipt(receipt, context) {
  const expected = {
    schema_version: 1,
    status: "policy_verified",
    outcome: "unchanged",
    kind: "lsp",
    repository: REPOSITORY,
    branch: INCIDENT.branch,
    url: PUBLIC_POLICY,
    sha256: DIGESTS.renewed,
    size: context.raw.renewed.length,
    blob_sha: INCIDENT.policy_blob,
    generated_at: INCIDENT.renewed_generated_at,
    expires_at: INCIDENT.renewed_expires_at,
    previous_sha256: null,
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(receipt[key], value);
  return Object.fromEntries(Object.keys(expected).map((key) => [key, receipt[key]]));
}

export async function recover(context, dependencies) {
  const { client, transport, publicRoot, workRoot, reviewedCommit } = dependencies;
  client.verifyBinary();
  for (const key of ["bootstrap", "renewed"])
    client.verify(context.files[key], context.files.public_key);
  await transport.admit(context);
  const before = await transport.observe(context);
  const attempts = [];
  for (const name of ["fresh-recovery", "same-state-replay"]) {
    // Only the original renewed bytes, already admitted as live, can reach this call.
    const receiptPath = join(workRoot, `${name}-receipt.json`);
    client.replay(context, receiptPath);
    const receipt = checkReceipt(JSON.parse(file(receiptPath, 65536)), context);
    const fetched = join(publicRoot, `${name}-fetched.json`);
    client.fetch(context, fetched);
    assert.deepEqual(file(fetched, 1048576), context.raw.renewed);
    client.verify(fetched, context.files.public_key);
    await transport.publicPolicy(context.raw.renewed);
    assert.deepEqual(
      await transport.observe(context),
      before,
      "replay changed policy head or bytes",
    );
    attempts.push({ attempt: name, receipt, fetched_sha256: sha(file(fetched)) });
  }
  const rollback = [];
  for (const renewal of [false, true]) {
    const refusal = client.rejectOlder(context, renewal);
    assert.deepEqual(
      await transport.observe(context),
      before,
      "rollback probe changed remote state",
    );
    rollback.push({ mode: renewal ? "renewal" : "plain", ...refusal });
  }
  return {
    schema_version: 1,
    qualification: "lsp-policy-original-intent-replay",
    status: "verified",
    repository: REPOSITORY,
    workflow_commit: reviewedCommit,
    config_sha256: context.config_sha256,
    cli_version: INCIDENT.cli_version,
    cli_sha256: INCIDENT.cli_sha256,
    failed_run: INCIDENT.failed_run,
    original_conclusion: "failure",
    original_cause: "not_established",
    operation_commit: INCIDENT.operation_commit,
    original_request_sha256: DIGESTS.request,
    original_failure_sha256: DIGESTS.failure,
    bootstrap_sha256: DIGESTS.bootstrap,
    renewed_sha256: DIGESTS.renewed,
    policy: before,
    attempts,
    rollback,
    catalog_head: INCIDENT.catalog_head,
    catalog_sha256: INCIDENT.catalog_sha256,
    inventory_sha256: INCIDENT.inventory_sha256,
    releases_preserved: 80,
    signing_performed: false,
    bootstrap_performed: false,
    production_changed: false,
  };
}

export function safeFailure(error) {
  const child = error?.diagnostic ?? {};
  return {
    status: "failed",
    message_sha256: sha(Buffer.from(String(error?.message ?? "failure"))),
    child_exit_status: Number.isInteger(child.exit_status) ? child.exit_status : null,
    child_signal: ["SIGKILL", "SIGTERM"].includes(child.signal) ? child.signal : null,
    process_error: ["ETIMEDOUT", "ENOBUFS", "ENOENT"].includes(child.process_error)
      ? child.process_error
      : null,
    cli_code:
      typeof child.cli_code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(child.cli_code)
        ? child.cli_code
        : null,
  };
}

export async function main(env = process.env) {
  const context = recoveryGuard(env);
  assert.ok(isAbsolute(env.RUNNER_TEMP) && realpathSync(env.RUNNER_TEMP) === env.RUNNER_TEMP);
  const publicRoot = join(env.RUNNER_TEMP, "qa-lsp-policy-recovery-public");
  const workRoot = join(env.RUNNER_TEMP, "qa-lsp-policy-recovery-work");
  for (const directory of [publicRoot, workRoot]) mkdirSync(directory, { mode: 0o700 });
  try {
    const proof = await recover(context, {
      client: cli(join(env.RUNNER_TEMP, "qa-cli/cadencr"), env),
      transport: network(env.CADENCR_REGISTRY_GITHUB_TOKEN),
      publicRoot,
      workRoot,
      reviewedCommit: env.REVIEWED_COMMIT,
    });
    writeFileSync(join(publicRoot, "proof.json"), JSON.stringify(proof) + "\n", { flag: "wx" });
  } catch (error) {
    writeFileSync(join(publicRoot, "failure.json"), JSON.stringify(safeFailure(error)) + "\n", {
      flag: "wx",
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--guard-only") {
    try {
      recoveryGuard();
    } catch (error) {
      process.stderr.write(JSON.stringify(safeFailure(error)) + "\n");
      process.exitCode = 1;
    }
  } else
    main().catch((error) => {
      process.stderr.write(JSON.stringify(safeFailure(error)) + "\n");
      process.exitCode = 1;
    });
}
