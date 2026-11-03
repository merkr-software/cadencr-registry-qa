import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { file, local, sha, REPOSITORY, VERSION, BINARY_SHA } from "./guard.mjs";
import { inventoryHash } from "./evidence.mjs";

export const INCIDENT = Object.freeze({
  failed_run: 41720393138,
  baseline_run: 41719150203,
  operation_commit: "97e199f88f0cd975d623cf45b497a0cb5cb4c07a",
  cli_version: "0.15.5",
  cli_sha256: "b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441",
  branch: "qa-policy-0155-lsp",
  policy_file: "managed-lsp-blocklist.json",
  policy_head: "dae9d692569076e2f51143391b61b078b8f53c63",
  bootstrap_commit: "47d6738e9f51c88bbe619773f9c72961811cab30",
  policy_blob: "b3feb9aeb6bb4a13ec62ce4a178241bafc75902c",
  renewed_generated_at: "2026-11-03T21:17:40Z",
  renewed_expires_at: "2026-11-05T20:53:41Z",
  catalog_head: "b3db06ac53784f217fb87f9e9d7f41d4db9b8fa9",
  catalog_sha256: "b9189c29393c17e3cfc8d2825e50d1a61333e8c46809087b780f21ae1e09b87f",
  inventory_sha256: "e9db51eb6115674c06a7a7b48f454e51b69f3b66bbc333a713714a270e00b143",
});
export const CONFIG = "requests/stable-0155-lsp-20261103/policy-recovery.json";
const root = "requests/stable-0155-lsp-20261103";
export const FILES = Object.freeze({
  request: `${root}/policy.json`,
  cli_pin: "cli-pin.env",
  public_key: `${root}/public.pem`,
  bootstrap: `${root}/policy-recovery/bootstrap.json`,
  renewed: `${root}/policy-recovery/renewed.json`,
  failure: `${root}/policy-recovery/failure.json`,
  catalog_baseline_proof: `${root}/policy-recovery/registry-before-policy.json`,
});
export const DIGESTS = Object.freeze({
  request: "fdab3bc3e62e2733a704fd4065c0bcd021e98573030902e116c2b957a9fb3711",
  cli_pin: "dfdcb3de13285e11b6f89b50d8f2da61a6119c5622e9cedb4e08432cde6780da",
  public_key: "e7f23eb02c1de202a3566c77dbb3b72fe65ae843a4dfe9dd5c49f6fb269780c4",
  bootstrap: "32ff34357f49c0926a48ed0bc2be6ec0a788ae2544fb37e374d36883b542243a",
  renewed: "59e218c0ca59b3f4b5b1cfa0df44c4e4eeb64ab499a68ccb927baf1c15846632",
  failure: "c689d676affd2b745571522b8a46af6e0d3ba32df04c9fdef6d2f791197d982f",
  catalog_baseline_proof: "7ab36c62273f0c71f4bb1552bb338686ae8997e2ca7535b3975947b1375dae35",
});

export function bindRun(run, baseline = false) {
  assert.equal(run.id, baseline ? INCIDENT.baseline_run : INCIDENT.failed_run);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.repository.id, 1420296872);
  assert.equal(run.head_repository.id, 1420296872);
  assert.equal(run.head_sha, INCIDENT.operation_commit);
  assert.equal(run.head_branch, "main");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.path, `.github/workflows/${baseline ? "qa" : "policy"}.yml`);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, baseline ? "success" : "failure");
}

export function bindDocuments(raw) {
  for (const key of Object.keys(FILES)) assert.equal(sha(raw[key]), DIGESTS[key]);
  const request = JSON.parse(raw.request);
  assert.equal(request.repository, REPOSITORY);
  assert.equal(request.discovery_branch, INCIDENT.branch);
  assert.equal(request.key_id, "qa-2026");
  assert.equal(request.renewal_expires_at, INCIDENT.renewed_expires_at);
  const bootstrap = JSON.parse(raw.bootstrap),
    renewed = JSON.parse(raw.renewed);
  for (const envelope of [bootstrap, renewed]) {
    assert.equal(envelope.signature.key_id, "qa-2026");
    assert.equal(envelope.signed.kind, "lsp-blocklist");
    assert.deepEqual(envelope.signed.entries, []);
  }
  assert.equal(renewed.signed.generated_at, INCIDENT.renewed_generated_at);
  assert.equal(renewed.signed.expires_at, INCIDENT.renewed_expires_at);
  assert.ok(Date.parse(bootstrap.signed.generated_at) < Date.parse(renewed.signed.generated_at));
  const baseline = JSON.parse(raw.catalog_baseline_proof);
  assert.equal(baseline.commit, INCIDENT.operation_commit);
  assert.equal(baseline.profile, "lsp-renewal");
  assert.equal(baseline.cli_sha256, INCIDENT.cli_sha256);
  assert.equal(inventoryHash(baseline.inventory), INCIDENT.inventory_sha256);
  assert.equal(baseline.inventory.head, INCIDENT.catalog_head);
  assert.equal(baseline.inventory.discovery_sha256, INCIDENT.catalog_sha256);
  assert.equal(baseline.inventory.releases.length, 80);
  return { request, bootstrap, renewed, baseline: baseline.inventory };
}

export function recoveryGuard(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, "1420296872");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${REPOSITORY}/.github/workflows/lsp-policy-recovery.yml@refs/heads/main`,
  );
  assert.match(env.REVIEWED_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_COMMIT);
  assert.match(env.CONFIG_SHA256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(VERSION, INCIDENT.cli_version);
  assert.equal(BINARY_SHA, INCIDENT.cli_sha256);
  const configBytes = file(local(CONFIG), 65536);
  assert.equal(sha(configBytes), env.CONFIG_SHA256);
  const config = JSON.parse(configBytes);
  assert.deepEqual(Object.keys(config).sort(), [
    "failed_run",
    "files",
    "operation_commit",
    "schema_version",
  ]);
  assert.equal(config.schema_version, 1);
  assert.equal(config.failed_run, INCIDENT.failed_run);
  assert.equal(config.operation_commit, INCIDENT.operation_commit);
  assert.deepEqual(config.files, FILES);
  const raw = Object.fromEntries(
    Object.entries(FILES).map(([key, path]) => [key, file(local(path))]),
  );
  return {
    ...bindDocuments(raw),
    raw,
    files: Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, resolve(path)])),
    config_sha256: env.CONFIG_SHA256,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  recoveryGuard();
