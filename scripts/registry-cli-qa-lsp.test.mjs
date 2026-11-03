import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveCoverage, continuity } from "./registry-cli-qa/evidence.mjs";
import { guard, sha, VERSION, BINARY_SHA } from "./registry-cli-qa/guard.mjs";
import {
  publicationCount,
  validateProfile,
  verificationArgs,
} from "./registry-cli-qa/profiles.mjs";

const repository = "merkr-software/cadencr-registry-qa";
const sourceTag = "qa-author-cli/stable-0155-lsp-20261103";
function fixture() {
  const binary = Object.fromEntries(
    ["darwin-aarch64", "linux-x86_64"].map((target) => [
      target,
      {
        archive: `https://github.com/${repository}/releases/download/${encodeURIComponent(sourceTag)}/${target}.tar.gz`,
        sha256: "a".repeat(64),
        size: 123,
        entry: "server.js",
        entry_sha256: "b".repeat(64),
        entry_size: 70,
        runtime: "node",
      },
    ]),
  );
  const submission = {
    schema_version: 2,
    source: {
      repository: `https://github.com/${repository}`,
      tag: sourceTag,
      commit: "c".repeat(40),
    },
    package: {
      kind: "lsp",
      package: {
        lsp: {
          id: "qa-author-lsp",
          version: "1.0.0",
          repository: `https://github.com/${repository}`,
          distribution: { binary },
        },
        host: { compatibility: { min_app_version: "999.0.0" } },
      },
    },
  };
  const plan = {
    profile: "lsp-incremental",
    phase: "incremental",
    mirror_tags: ["lsp-qa-author-lsp-v1.0.0"],
    added_entry_sha256: ["d".repeat(64)],
  };
  return {
    plan,
    submission,
    request: { publications: [{ submission: "lsp-submission.json" }] },
  };
}

test("LSP profile binds one QA Node publication and preserves legacy cardinalities", () => {
  const { plan, request, submission } = fixture();
  validateProfile(plan, request, [submission], plan.profile);
  assert.equal(publicationCount(plan), 1);
  assert.equal(publicationCount({ phase: "incremental" }), 3);
  assert.equal(publicationCount({ phase: "renewal" }), 0);
  assert.throws(() => validateProfile({ phase: "incremental" }, request, [submission]));
  assert.throws(() => validateProfile(plan, request, [submission]));
  assert.throws(() => validateProfile(plan, request, [submission], "incremental"));
});

test("LSP profile rejects namespace, cardinality, source, receipt, target and fault drift", () => {
  for (const mutate of [
    (v) => {
      v.plan.profile = "lsp-other";
    },
    (v) => {
      v.plan.phase = "renewal";
    },
    (v) => {
      v.request.publications.push(v.request.publications[0]);
    },
    (v) => {
      v.submission.package.kind = "provider";
    },
    (v) => {
      v.submission.source.repository = "https://github.com/other/qa";
    },
    (v) => {
      v.submission.source.commit = "main";
    },
    (v) => {
      v.submission.source.tag = "v1";
    },
    (v) => {
      v.submission.package.package.lsp.repository = "https://github.com/other/qa";
    },
    (v) => {
      v.submission.package.package.host.compatibility.min_app_version = "0.16.1";
    },
    (v) => {
      delete v.submission.package.package.lsp.distribution.binary["darwin-aarch64"];
    },
    (v) => {
      v.submission.package.package.lsp.distribution.binary.other = {};
    },
    (v) => {
      v.submission.package.package.lsp.distribution.binary["linux-x86_64"].archive =
        "https://other.example/a";
    },
    (v) => {
      v.submission.package.package.lsp.distribution.binary["linux-x86_64"].runtime = "native";
    },
    (v) => {
      v.submission.package.package.lsp.distribution.binary["linux-x86_64"].entry = "other.js";
    },
    (v) => {
      v.submission.package.package.lsp.distribution.binary["linux-x86_64"].entry_sha256 = "bad";
    },
    (v) => {
      v.plan.mirror_tags = [];
    },
    (v) => {
      v.plan.added_entry_sha256 = ["invalid"];
    },
    (v) => {
      v.plan.fault = {};
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() =>
      validateProfile(value.plan, value.request, [value.submission], value.plan.profile),
    );
  }
});

test("LSP archive coverage binds every reviewed archive and launch entry field", () => {
  const { submission } = fixture();
  const catalog = { signed: { packages: [submission.package] } };
  const targets = Object.values(submission.package.package.lsp.distribution.binary);
  const archives = targets.map(({ archive, ...bound }) => ({
    url: archive,
    ...bound,
  }));
  archiveCoverage(catalog, archives);
  for (const field of ["sha256", "size", "entry", "entry_sha256", "entry_size", "runtime"])
    assert.throws(() =>
      archiveCoverage(
        catalog,
        archives.map((value, index) =>
          index
            ? value
            : {
                ...value,
                [field]: field.includes("size") ? value[field] + 1 : "wrong",
              },
        ),
      ),
    );
  assert.throws(() => archiveCoverage(catalog, archives.slice(1)));
  assert.throws(() => archiveCoverage(catalog, [...archives, archives[0]]));
  assert.throws(() =>
    archiveCoverage(catalog, [...archives, { ...archives[0], url: archives[0].url + "extra" }]),
  );
  assert.throws(() =>
    archiveCoverage(
      catalog,
      targets.map(({ archive, sha256, size }) => ({
        url: archive,
        sha256,
        size,
      })),
    ),
  );
});

test("LSP delta adds exactly one bound entry; renewal preserves the real LSP baseline", () => {
  const { submission, plan } = fixture();
  const previous = {
    signed: {
      packages: [],
      generated_at: "2026-01-01",
      expires_at: "2026-01-02",
    },
  };
  const current = {
    signed: {
      packages: [submission.package],
      generated_at: "2026-01-02",
      expires_at: "2026-01-03",
    },
  };
  plan.added_entry_sha256 = [sha(Buffer.from(JSON.stringify(submission.package)))];
  continuity(previous, current, plan);
  assert.throws(() => continuity(previous, current, { ...plan, profile: undefined }));
  const renewal = {
    profile: "lsp-renewal",
    phase: "renewal",
    mirror_tags: [],
    added_entry_sha256: [],
  };
  validateProfile(renewal, { publications: [] }, [], renewal.profile, current);
  for (const mutate of [
    (v) => {
      v.package.lsp.repository = "https://github.com/other/repository";
    },
    (v) => {
      v.package.host.compatibility.min_app_version = "0.16.1";
    },
  ]) {
    const changed = structuredClone(current);
    mutate(changed.signed.packages[0]);
    assert.throws(() =>
      validateProfile(renewal, { publications: [] }, [], renewal.profile, changed),
    );
  }
  assert.throws(() =>
    validateProfile(renewal, { publications: [] }, [], renewal.profile, previous),
  );
  assert.throws(() =>
    validateProfile(renewal, { publications: [{}] }, [], renewal.profile, current),
  );
  assert.throws(() =>
    validateProfile(
      { ...renewal, mirror_tags: ["extra"] },
      { publications: [] },
      [],
      renewal.profile,
      current,
    ),
  );
  const renewed = structuredClone(current);
  renewed.signed.generated_at = "2026-01-03";
  renewed.signed.expires_at = "2026-01-04";
  continuity(current, renewed, renewal);
  renewed.signed.packages = [];
  assert.throws(() => continuity(current, renewed, renewal));
});

test("only explicit baseline verification permits expired indexes", () => {
  assert.ok(verificationArgs("previous", "public", "qa", "baseline").includes("--allow-expired"));
  assert.ok(!verificationArgs("candidate", "public", "qa").includes("--allow-expired"));
  assert.throws(() => verificationArgs("candidate", "public", "qa", "arbitrary"));
  assert.equal(VERSION, "0.15.5");
  assert.equal(BINARY_SHA, "b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441");
});

test("real guard hash-binds selected LSP plan, submission, public key and baseline", () => {
  const cwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "lsp-registry-guard-"));
  const { plan, request, submission } = fixture();
  mkdirSync(join(directory, "requests"));
  const put = (name, value) => {
    const raw = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    writeFileSync(join(directory, "requests", name), raw);
    return sha(raw);
  };
  const previousSha = put("previous.json", { signed: { packages: [] } });
  const publicSha = put("public.pem", "inert public test data");
  const submissionSha = put("lsp-submission.json", submission);
  Object.assign(request, {
    schema_version: 2,
    repository,
    discovery_branch: "marketplace-v2",
    previous_index: "previous.json",
    public_key: "public.pem",
    key_id: "qa-2026",
  });
  Object.assign(plan, {
    request: "requests/incremental.json",
    previous: "requests/previous.json",
    previous_sha256: previousSha,
    public_key: "requests/public.pem",
    public_key_sha256: publicSha,
    key_id: "qa-2026",
    inputs: { "requests/lsp-submission.json": submissionSha },
  });
  const requestSha = put("incremental.json", request);
  const planSha = put("lsp-incremental-plan.json", plan);
  const env = {
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: "1420296872",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    QA_DEFAULT_BRANCH: "main",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    REVIEWED_COMMIT: "a".repeat(40),
    QA_RUNNER: "first",
    QA_PHASE: "lsp-incremental",
    QA_PLAN: "requests/lsp-incremental-plan.json",
    REQUEST_SHA256: requestSha,
    PLAN_SHA256: planSha,
  };
  process.chdir(directory);
  try {
    guard(env);
    for (const change of [
      { QA_PHASE: "incremental" },
      { PLAN_SHA256: "0".repeat(64) },
      { REQUEST_SHA256: "0".repeat(64) },
      { REVIEWED_COMMIT: "b".repeat(40) },
      { GITHUB_REPOSITORY: "other/repo" },
    ])
      assert.throws(() => guard({ ...env, ...change }));
    put("lsp-submission.json", {
      ...submission,
      source: { ...submission.source, repository: "other" },
    });
    assert.throws(() => guard(env));
  } finally {
    process.chdir(cwd);
  }
  assert.ok(readFileSync(join(directory, "requests/previous.json")).length);
});
