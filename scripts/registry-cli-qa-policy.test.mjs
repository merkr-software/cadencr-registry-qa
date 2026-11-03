import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyGuard, REQUEST, LSP_REQUEST } from "./registry-cli-qa/policy-guard.mjs";
const repository = process.cwd();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Each case works in a scratch copy of the reviewed request directory, then returns.
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), "policy-guard-"));
  cpSync(
    join(repository, "requests/stable-0152-20261025"),
    join(directory, "requests/stable-0152-20261025"),
    {
      recursive: true,
    },
  );
  return directory;
}
function environment(directory, profile = "legacy") {
  const requestSha = sha(readFileSync(join(directory, profile === "lsp" ? LSP_REQUEST : REQUEST)));
  return {
    GITHUB_REPOSITORY: "merkr-software/cadencr-registry-qa",
    GITHUB_REPOSITORY_ID: "1420296872",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    QA_DEFAULT_BRANCH: "main",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF:
      "merkr-software/cadencr-registry-qa/.github/workflows/policy.yml@refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    REVIEWED_COMMIT: "a".repeat(40),
    REQUEST_SHA256: requestSha,
    QA_POLICY_PROFILE: profile,
  };
}
function inside(directory, operation) {
  process.chdir(directory);
  try {
    return operation();
  } finally {
    process.chdir(repository);
  }
}
test("policy guard accepts the exact reviewed inert request", () => {
  const directory = scratch();
  const { request, payloads } = inside(directory, () => policyGuard(environment(directory)));
  assert.deepEqual(Object.keys(payloads), ["provider", "theme", "tab"]);
  assert.equal(request.policies.length, 3);
});
test("policy guard rejects wrong commit, workflow, request digest and repository", () => {
  const directory = scratch();
  const good = environment(directory);
  for (const change of [
    { REVIEWED_COMMIT: "b".repeat(40) },
    {
      GITHUB_WORKFLOW_REF: good.GITHUB_WORKFLOW_REF.replace("policy.yml", "qa.yml"),
    },
    { REQUEST_SHA256: "0".repeat(64) },
    { GITHUB_REPOSITORY: "merkr-software/cadencr-registry" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_EVENT_NAME: "push" },
  ])
    assert.throws(() => inside(directory, () => policyGuard({ ...good, ...change })));
});
test("policy guard rejects re-bound payloads, non-empty entries and over-long windows", () => {
  for (const mutate of [
    (p) => ({ ...p, entries: [{ provider_id: "x", reason: "r" }] }),
    (p) => ({ ...p, expires_at: "2026-11-30T17:30:00Z" }),
    (p) => ({ ...p, generated_at: "2026-10-25T17:30:00.000Z" }),
  ]) {
    const directory = scratch();
    const path = join(directory, "requests/stable-0152-20261025/provider-policy.json");
    const bytes = Buffer.from(JSON.stringify(mutate(JSON.parse(readFileSync(path)))));
    writeFileSync(path, bytes);
    // Re-bind the digest so the semantic checks, not the digest check, must reject the change.
    const requestPath = join(directory, REQUEST);
    const request = JSON.parse(readFileSync(requestPath));
    request.policies[0].payload_sha256 = sha(bytes);
    writeFileSync(requestPath, JSON.stringify(request));
    assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
  }
});
test("policy guard rejects an unreviewed discovery branch", () => {
  const directory = scratch();
  const path = join(directory, REQUEST);
  const request = JSON.parse(readFileSync(path));
  request.discovery_branch = "main";
  writeFileSync(path, JSON.stringify(request));
  assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
});
test("policy guard requires no settle delay between bootstrap and renewal", () => {
  for (const settle of [undefined, 1, 330]) {
    const directory = scratch();
    const path = join(directory, REQUEST);
    const request = JSON.parse(readFileSync(path));
    request.cdn_settle_seconds = settle;
    writeFileSync(path, JSON.stringify(request));
    assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
  }
});
test("policy guard rejects a renewal that does not outlive the bootstrap", () => {
  const directory = scratch();
  const path = join(directory, REQUEST);
  const request = JSON.parse(readFileSync(path));
  request.renewal_expires_at = "2026-10-30T00:00:00Z";
  writeFileSync(path, JSON.stringify(request));
  assert.throws(() => inside(directory, () => policyGuard(environment(directory))));
});

// Synthetic request bytes exercise guards only; never published or retained as qualification proof.
function lspScratch() {
  const directory = scratch();
  const path = join(directory, "requests/stable-0155-lsp-20261103");
  mkdirSync(path);
  const legacy = JSON.parse(readFileSync(join(directory, REQUEST)));
  const publicBytes = readFileSync(
    join(directory, "requests/stable-0152-20261025", legacy.public_key),
  );
  writeFileSync(join(path, "public.pem"), publicBytes);
  const payload = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      kind: "lsp-blocklist",
      generated_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-02T00:00:00Z",
      entries: [],
    }),
  );
  writeFileSync(join(path, "lsp-policy.json"), payload);
  const request = {
    schema_version: 1,
    repository: "merkr-software/cadencr-registry-qa",
    discovery_branch: "qa-policy-0155-lsp",
    key_id: "qa-2026",
    public_key: "public.pem",
    public_key_sha256: sha(publicBytes),
    renewal_expires_at: "2026-01-03T00:00:00Z",
    policies: [
      {
        kind: "lsp",
        file: "managed-lsp-blocklist.json",
        payload: "lsp-policy.json",
        payload_sha256: sha(payload),
      },
    ],
    cdn_settle_seconds: 0,
  };
  writeFileSync(join(directory, LSP_REQUEST), JSON.stringify(request));
  return directory;
}

test("LSP policy profile selects only its fixed inert request and QA feed namespace", () => {
  const directory = lspScratch();
  const env = environment(directory, "lsp");
  const result = inside(directory, () => policyGuard(env));
  assert.equal(result.profile, "lsp");
  assert.deepEqual(result.kinds, ["lsp"]);
  assert.deepEqual(Object.keys(result.payloads), ["lsp"]);
  assert.equal(result.request.discovery_branch, "qa-policy-0155-lsp");
  assert.equal(result.request.policies[0].file, "managed-lsp-blocklist.json");
  assert.throws(() =>
    inside(directory, () => policyGuard({ ...env, QA_POLICY_PROFILE: "legacy" })),
  );
  assert.throws(() =>
    inside(directory, () => policyGuard({ ...env, QA_POLICY_PROFILE: "arbitrary" })),
  );
});

test("LSP policy guard rejects branch, feed path, kind and publication scope changes", () => {
  for (const change of [
    (r) => {
      r.discovery_branch = "marketplace-v2";
    },
    (r) => {
      r.discovery_branch = "main";
    },
    (r) => {
      r.discovery_branch = "qa-policy-0152-r2";
    },
    (r) => {
      r.policies[0].file = "managed-index.json";
    },
    (r) => {
      r.policies[0].kind = "theme";
    },
    (r) => {
      r.policies.push({ ...r.policies[0] });
    },
    (r) => {
      r.repository = "merkr-software/cadencr-registry";
    },
    (r) => {
      r.public_key_sha256 = "0".repeat(64);
    },
  ]) {
    const directory = lspScratch();
    const path = join(directory, LSP_REQUEST);
    const request = JSON.parse(readFileSync(path));
    change(request);
    writeFileSync(path, JSON.stringify(request));
    assert.throws(() => inside(directory, () => policyGuard(environment(directory, "lsp"))));
  }
});

test("LSP policy rejects wrong signing domain, actual revocations and rebound payload tampering", () => {
  for (const change of [
    (p) => {
      p.kind = "theme-blocklist";
    },
    (p) => {
      p.entries = [{ lsp_id: "qa-author-lsp", reason: "not inert" }];
    },
    (p) => {
      p.expires_at = "2026-02-01T00:00:00Z";
    },
  ]) {
    const directory = lspScratch();
    const path = join(directory, "requests/stable-0155-lsp-20261103/lsp-policy.json");
    const payload = JSON.parse(readFileSync(path));
    change(payload);
    const raw = Buffer.from(JSON.stringify(payload));
    writeFileSync(path, raw);
    const requestPath = join(directory, LSP_REQUEST);
    const request = JSON.parse(readFileSync(requestPath));
    request.policies[0].payload_sha256 = sha(raw);
    writeFileSync(requestPath, JSON.stringify(request));
    assert.throws(() => inside(directory, () => policyGuard(environment(directory, "lsp"))));
  }
});
