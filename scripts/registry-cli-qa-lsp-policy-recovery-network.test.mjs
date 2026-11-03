import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPOSITORY } from "./registry-cli-qa/guard.mjs";
import { INCIDENT, FILES, bindDocuments } from "./registry-cli-qa/lsp-policy-recovery-guard.mjs";
import { network } from "./registry-cli-qa/lsp-policy-recovery-client.mjs";
const raw = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, readFileSync(path)]),
);
const context = () => ({ ...bindDocuments(raw), raw });
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

test("network admission binds original API intent and commit chain using GET only", async (t) => {
  const ctx = context();
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method ?? "GET", "GET");
    const parsed = new URL(url),
      path = parsed.pathname + parsed.search;
    paths.push(path);
    if (parsed.hostname === "raw.githubusercontent.com") {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(raw.renewed);
    }
    assert.equal(parsed.hostname, "api.github.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-token");
    const relative = path.slice(`/repos/${REPOSITORY}`.length);
    let value;
    const content = (data) => ({
      type: "file",
      encoding: "base64",
      content: data.toString("base64"),
    });
    if (!relative) value = { id: 1420296872, full_name: REPOSITORY, private: false };
    else if (relative === `/actions/runs/${INCIDENT.failed_run}`) value = run();
    else if (relative === `/actions/runs/${INCIDENT.baseline_run}`) value = run(true);
    else if (relative === `/contents/${FILES.request}?ref=${INCIDENT.operation_commit}`)
      value = content(raw.request);
    else if (relative === `/contents/${FILES.cli_pin}?ref=${INCIDENT.operation_commit}`)
      value = content(raw.cli_pin);
    else if (relative === `/contents/${INCIDENT.policy_file}?ref=${INCIDENT.operation_commit}`)
      return new Response("not found", { status: 404 });
    else if (relative === `/git/commits/${INCIDENT.bootstrap_commit}`)
      value = {
        sha: INCIDENT.bootstrap_commit,
        parents: [{ sha: INCIDENT.operation_commit }],
        committer: { date: "2026-11-03T21:17:36Z" },
      };
    else if (relative === `/git/commits/${INCIDENT.policy_head}`)
      value = {
        sha: INCIDENT.policy_head,
        parents: [{ sha: INCIDENT.bootstrap_commit }],
        committer: { date: "2026-11-03T21:17:42Z" },
      };
    else if (relative === `/contents/${INCIDENT.policy_file}?ref=${INCIDENT.bootstrap_commit}`)
      value = content(raw.bootstrap);
    else if (relative === `/git/ref/heads/${INCIDENT.branch}`)
      value = { object: { sha: INCIDENT.policy_head } };
    else if (relative === `/contents/${INCIDENT.policy_file}?ref=${INCIDENT.policy_head}`)
      value = { ...content(raw.renewed), sha: INCIDENT.policy_blob, size: raw.renewed.length };
    else assert.fail("unexpected API path");
    return new Response(JSON.stringify(value));
  });
  const adapter = network("synthetic-token", async (token) => {
    assert.equal(token, "synthetic-token");
    return structuredClone(ctx.baseline);
  });
  await adapter.admit(ctx);
  assert.equal((await adapter.observe(ctx)).head, INCIDENT.policy_head);
  await adapter.publicPolicy(raw.renewed);
  assert.ok(paths.some((path) => path.includes(INCIDENT.bootstrap_commit)));
  const drifted = network("synthetic-token", async () => ({ ...ctx.baseline, head: "changed" }));
  await assert.rejects(drifted.observe(ctx));
});

test("workflow exposes only the QA job token and a strict public artifact allowlist", () => {
  const workflow = readFileSync(".github/workflows/lsp-policy-recovery.yml", "utf8");
  assert.ok(!workflow.includes("QA_SIGNING_KEY_PEM") && !workflow.includes("secrets."));
  assert.ok(workflow.includes("persist-credentials: false"));
  assert.ok(workflow.includes("group: registry-qa-lifecycle"));
  assert.ok(workflow.includes("lsp-policy-recovery.mjs --guard-only"));
  assert.ok(!workflow.includes("qa-lsp-policy-recovery-work/"));
  const policy = readFileSync("scripts/registry-cli-qa/policy.mjs", "utf8");
  assert.ok(policy.includes("timeout: 900000"));
});
