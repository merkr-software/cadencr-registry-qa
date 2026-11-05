import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProfile } from "../registry-cli-qa/profiles.mjs";

const repo = "merkr-software/cadencr-registry-qa";
function entry(version) {
  const target = { archive: `https://github.com/${repo}/releases/download/qa-author-cli%2Fstable-0156-test/lsp.tar.gz`,
    sha256: "a".repeat(64), size: 70, entry: "server.js", entry_sha256: "b".repeat(64), entry_size: 20, runtime: "node" };
  return { kind: "lsp", package: { lsp: { id: "qa-author-lsp", version,
    repository: `https://github.com/${repo}`,
    distribution: { binary: { "darwin-aarch64": { ...target }, "linux-x86_64": { ...target } } } },
    host: { compatibility: { min_app_version: "999.0.0" } } } };
}

test("0.15.6 incremental uses a new inert version and rejects republishing 0.15.5 history", () => {
  const previous = process.env.QA_CLI_PROFILE;
  process.env.QA_CLI_PROFILE = "cli0156";
  try {
    const plan = { profile: "lsp-incremental", phase: "incremental",
      mirror_tags: ["lsp-qa-author-lsp-v1.0.1"], added_entry_sha256: ["c".repeat(64)] };
    const request = { publications: [{ submission: "lsp-submission.json" }] };
    const submission = { schema_version: 2, package: entry("1.0.1"), source: {
      repository: `https://github.com/${repo}`, tag: "qa-author-cli/stable-0156-test", commit: "d".repeat(40) } };
    validateProfile(plan, request, [submission], "lsp-incremental");
    submission.package.package.lsp.version = "1.0.0";
    assert.throws(() => validateProfile(plan, request, [submission], "lsp-incremental"));
  } finally {
    if (previous === undefined) delete process.env.QA_CLI_PROFILE;
    else process.env.QA_CLI_PROFILE = previous;
  }
});

test("0.15.6 renewal preserves both exact historical fixture versions", () => {
  const previous = process.env.QA_CLI_PROFILE;
  process.env.QA_CLI_PROFILE = "cli0156";
  try {
    const plan = { profile: "lsp-renewal", phase: "renewal", mirror_tags: [], added_entry_sha256: [] };
    const request = { publications: [] };
    const baseline = { signed: { packages: [entry("1.0.0"), entry("1.0.1")] } };
    validateProfile(plan, request, [], "lsp-renewal", baseline);
    for (const versions of [["1.0.0"], ["1.0.1"], ["1.0.0", "1.0.1", "1.0.2"]]) {
      assert.throws(() => validateProfile(plan, request, [], "lsp-renewal",
        { signed: { packages: versions.map(entry) } }));
    }
  } finally {
    if (previous === undefined) delete process.env.QA_CLI_PROFILE;
    else process.env.QA_CLI_PROFILE = previous;
  }
});

test("registry binary defaults remain 0.15.5; explicit modern selection requires finalized data", () => {
  const guard = new URL("../registry-cli-qa/guard.mjs", import.meta.url).href;
  const script = `import { VERSION, BINARY_SHA } from ${JSON.stringify(guard)}; console.log(VERSION, BINARY_SHA);`;
  const scratch = mkdtempSync(join(tmpdir(), "cli0156-registry-profile-"));
  const env = { PATH: process.env.PATH };
  const probe = (extra) => spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { cwd: scratch, env: { ...env, ...extra }, encoding: "utf8" });
  const old = probe({});
  assert.equal(old.status, 0);
  assert.equal(old.stdout.trim(), "0.15.5 b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441");
  assert.notEqual(probe({ QA_CLI_PROFILE: "cli0156" }).status, 0);
  assert.notEqual(probe({ QA_CLI_PROFILE: "other" }).status, 0);
  const folder = join(scratch, "requests/cli0156");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "profile.json"), JSON.stringify({ schema_version: 1,
    status: "FINALIZED_PUBLIC_RELEASE", repository: "merkr-software/CadencR", version: "0.15.6",
    tag: "cli/v0.15.6", source_commit: "a".repeat(40), cli_sha256: "b".repeat(64), run_id: "1", run_attempt: "1" }));
  const modern = probe({ QA_CLI_PROFILE: "cli0156" });
  assert.equal(modern.status, 0);
  assert.equal(modern.stdout.trim(), "0.15.6 " + "b".repeat(64));
});
