import assert from "node:assert/strict";

const REPOSITORY = "merkr-software/cadencr-registry-qa";
export const LSP_TARGETS = ["darwin-aarch64", "linux-x86_64"];
export function publicationCount(plan) {
  assert.ok(["incremental", "renewal"].includes(plan.phase));
  if (plan.profile !== undefined)
    assert.equal(plan.profile, `lsp-${plan.phase}`, "unknown or mismatched LSP profile");
  return plan.phase === "renewal" ? 0 : plan.profile ? 1 : 3;
}

export function lspBinding(target) {
  assert.match(target.sha256, /^[a-f0-9]{64}$/);
  assert.match(target.entry_sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(target.size) && target.size > 0 && target.size <= 64 * 1024 * 1024,
  );
  assert.ok(
    Number.isSafeInteger(target.entry_size) &&
      target.entry_size > 0 &&
      target.entry_size <= 256 * 1024 * 1024,
  );
  assert.equal(target.runtime, "node", "QA LSP fixtures are prepared Node bundles only");
  assert.equal(target.entry, "server.js");
  return Object.fromEntries(
    ["sha256", "size", "entry", "entry_sha256", "entry_size", "runtime"].map((key) => [
      key,
      target[key],
    ]),
  );
}

export function validateProfile(plan, request, submissions, selected, previous) {
  const count = publicationCount(plan);
  assert.equal(request.publications.length, count);
  if (selected !== undefined) assert.equal(selected, plan.profile ?? plan.phase);
  if (!plan.profile) return;
  assert.equal(selected, plan.profile, "LSP profile must bind the workflow selection");
  assert.ok(!plan.fault, "LSP profile does not inject the theme-only fault");
  for (const name of ["mirror_tags", "added_entry_sha256"]) {
    assert.equal(plan[name].length, count);
    assert.equal(new Set(plan[name]).size, count);
  }
  if (plan.phase === "renewal") {
    const existing = previous.signed.packages.filter((entry) => entry.kind === "lsp");
    const versions = process.env.QA_CLI_PROFILE === "cli0157" ? ["1.0.0", "1.0.1", "1.0.2"] : process.env.QA_CLI_PROFILE === "cli0156" ? ["1.0.0", "1.0.1"] : ["1.0.0"];
    assert.deepEqual(existing.map((entry) => entry.package.lsp.version).sort(), versions,
      "LSP renewal must preserve every reviewed historical fixture version");
    for (const entry of existing) {
      assert.equal(entry.package.lsp.id, "qa-author-lsp");
      assert.equal(entry.package.lsp.repository, `https://github.com/${REPOSITORY}`);
      assert.equal(entry.package.host.compatibility.min_app_version, "999.0.0");
      assert.deepEqual(Object.keys(entry.package.lsp.distribution.binary).sort(), LSP_TARGETS);
      for (const target of Object.values(entry.package.lsp.distribution.binary)) lspBinding(target);
    }
    return;
  }
  const submission = submissions[0];
  assert.equal(submission.schema_version, 2);
  assert.equal(submission.package.kind, "lsp");
  assert.equal(submission.source.repository, `https://github.com/${REPOSITORY}`);
  assert.match(submission.source.commit, /^[a-f0-9]{40}$/);
  assert.match(submission.source.tag, /^qa-author-cli\/[a-z0-9][a-z0-9-]{5,79}$/);
  const descriptor = submission.package.package.lsp;
  assert.equal(descriptor.id, "qa-author-lsp");
  if (process.env.QA_CLI_PROFILE === "cli0156") assert.equal(descriptor.version, "1.0.1");
  if (process.env.QA_CLI_PROFILE === "cli0157") assert.equal(descriptor.version, "1.0.2");
  assert.equal(descriptor.repository, `https://github.com/${REPOSITORY}`);
  assert.equal(submission.package.package.host.compatibility.min_app_version, "999.0.0");
  assert.deepEqual(Object.keys(descriptor.distribution.binary).sort(), LSP_TARGETS);
  assert.ok(
    descriptor.distribution.repository === undefined ||
      descriptor.distribution.repository === descriptor.repository,
  );
  const sourcePrefix = `${descriptor.repository}/releases/download/${encodeURIComponent(submission.source.tag)}/`;
  for (const target of Object.values(descriptor.distribution.binary)) {
    lspBinding(target);
    assert.ok(
      target.archive.startsWith(sourcePrefix),
      "LSP archive must belong to its QA author release",
    );
  }
  assert.deepEqual(plan.mirror_tags, [`lsp-${descriptor.id}-v${descriptor.version}`]);
  assert.match(plan.added_entry_sha256[0], /^[a-f0-9]{64}$/);
}

export function verificationArgs(index, publicKey, keyId, mode = "current") {
  assert.ok(["current", "baseline"].includes(mode));
  return [
    "registry",
    "verify-index",
    "--index",
    index,
    "--public-key",
    publicKey,
    "--key-id",
    keyId,
    ...(mode === "baseline" ? ["--allow-expired"] : []),
  ];
}
