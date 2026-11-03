import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { file, sha, REPOSITORY } from "./guard.mjs";
import { bytes, inventory, childEnvironment, failureDiagnostic } from "./evidence.mjs";
import { INCIDENT, FILES, DIGESTS, bindRun } from "./lsp-policy-recovery-guard.mjs";

export const POLICY_TIMEOUT_MS = 900000;
export const PUBLIC_POLICY = `https://raw.githubusercontent.com/${REPOSITORY}/refs/heads/${INCIDENT.branch}/${INCIDENT.policy_file}`;
export const ROLLBACK_MESSAGE =
  "rollback refused: the candidate managed-lsp-blocklist.json is not generated after the published one";

export function bindPolicy(head, content, renewed) {
  assert.equal(head.object.sha, INCIDENT.policy_head);
  assert.equal(content.type, "file");
  assert.equal(content.encoding, "base64");
  assert.equal(content.sha, INCIDENT.policy_blob);
  const data = Buffer.from(content.content, "base64");
  assert.deepEqual(data, renewed);
  assert.equal(content.size, data.length);
  assert.equal(sha(data), DIGESTS.renewed);
  return { head: head.object.sha, blob: content.sha, sha256: sha(data), size: data.length };
}

export function network(token, readInventory = inventory) {
  assert.ok(typeof token === "string" && token.trim(), "QA job token required");
  const get = async (path, absent = false) => {
    const signal = AbortSignal.timeout(60000);
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal,
      redirect: "error",
    });
    if (absent && response.status === 404) return null;
    assert.equal(response.status, 200);
    const parts = [];
    let length = 0;
    for await (const part of response.body) {
      signal.throwIfAborted();
      length += part.length;
      assert.ok(length <= 16777216, "API response exceeds bound");
      parts.push(part);
    }
    return JSON.parse(Buffer.concat(parts));
  };
  return {
    async admit(context) {
      const repository = await get("");
      assert.equal(repository.id, 1420296872);
      assert.equal(repository.full_name, REPOSITORY);
      assert.equal(repository.private, false);
      bindRun(await get(`/actions/runs/${INCIDENT.failed_run}`));
      bindRun(await get(`/actions/runs/${INCIDENT.baseline_run}`), true);
      for (const key of ["request", "cli_pin"]) {
        const content = await get(`/contents/${FILES[key]}?ref=${INCIDENT.operation_commit}`);
        assert.equal(content.type, "file");
        assert.equal(content.encoding, "base64");
        assert.deepEqual(Buffer.from(content.content, "base64"), context.raw[key]);
      }
      assert.equal(
        await get(`/contents/${INCIDENT.policy_file}?ref=${INCIDENT.operation_commit}`, true),
        null,
      );
      for (const [commit, parent, date] of [
        [INCIDENT.bootstrap_commit, INCIDENT.operation_commit, "2026-11-03T21:17:36Z"],
        [INCIDENT.policy_head, INCIDENT.bootstrap_commit, "2026-11-03T21:17:42Z"],
      ]) {
        const observed = await get(`/git/commits/${commit}`);
        assert.equal(observed.sha, commit);
        assert.deepEqual(
          observed.parents.map((entry) => entry.sha),
          [parent],
        );
        assert.equal(observed.committer.date, date);
      }
      const originalBootstrap = await get(
        `/contents/${INCIDENT.policy_file}?ref=${INCIDENT.bootstrap_commit}`,
      );
      assert.equal(originalBootstrap.type, "file");
      assert.equal(originalBootstrap.encoding, "base64");
      assert.deepEqual(Buffer.from(originalBootstrap.content, "base64"), context.raw.bootstrap);
    },
    async observe(context) {
      const ref = `/git/ref/heads/${INCIDENT.branch}`;
      const head = await get(ref);
      assert.equal(head.object.sha, INCIDENT.policy_head);
      const content = await get(`/contents/${INCIDENT.policy_file}?ref=${INCIDENT.policy_head}`);
      const policy = bindPolicy(head, content, context.raw.renewed);
      assert.equal((await get(ref)).object.sha, policy.head);
      const registry = await readInventory(token);
      assert.deepEqual(registry, context.baseline, "catalog or release inventory changed");
      return policy;
    },
    async publicPolicy(expected) {
      for (const url of [
        PUBLIC_POLICY,
        `https://raw.githubusercontent.com/${REPOSITORY}/${INCIDENT.policy_head}/${INCIDENT.policy_file}`,
      ])
        assert.deepEqual(await bytes(url, { "Cache-Control": "no-cache" }), expected);
    },
  };
}

export function publicationArgs(context, older = false, renewal = true, receipt) {
  return [
    "registry",
    "publish-policy",
    "--kind",
    "lsp",
    "--signed",
    older ? context.files.bootstrap : context.files.renewed,
    "--repository",
    REPOSITORY,
    "--discovery-branch",
    INCIDENT.branch,
    "--public-key",
    context.files.public_key,
    "--key-id",
    "qa-2026",
    ...(renewal ? ["--renewal"] : []),
    ...(receipt ? ["--receipt", receipt] : []),
  ];
}

export function cli(binary, env, spawn = spawnSync) {
  const run = (args, authenticated = false) =>
    spawn(binary, args[0] === "--version" ? args : ["--json", ...args], {
      env: childEnvironment(env, authenticated),
      encoding: "utf8",
      timeout: POLICY_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 1048576,
    });
  const execute = (args, authenticated = false) => {
    const result = run(args, authenticated);
    if (result.error || result.status !== 0) {
      const error = new Error("policy recovery CLI failed");
      error.diagnostic = failureDiagnostic(result);
      throw error;
    }
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  return {
    verifyBinary() {
      const data = file(binary, 128 * 1024 * 1024);
      assert.equal(sha(data), INCIDENT.cli_sha256);
      assert.ok(
        data.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) &&
          data[18] === 62 &&
          data[19] === 0,
        "exact Linux x86_64 ELF required",
      );
      assert.equal(execute(["--version"]), `cadencr ${INCIDENT.cli_version}\n`);
    },
    verify(path, publicKey) {
      execute([
        "registry",
        "verify-lsp-blocklist",
        "--index",
        path,
        "--public-key",
        publicKey,
        "--key-id",
        "qa-2026",
      ]);
    },
    replay(context, receipt) {
      execute(publicationArgs(context, false, true, receipt), true);
    },
    fetch(context, output) {
      execute(
        [
          "registry",
          "fetch-policy",
          "--kind",
          "lsp",
          "--repository",
          REPOSITORY,
          "--discovery-branch",
          INCIDENT.branch,
          "--output",
          output,
        ],
        true,
      );
    },
    rejectOlder(context, renewal) {
      const result = run(publicationArgs(context, true, renewal), true);
      assert.ok(
        !result.error && result.status === 1 && result.stdout === "",
        "rollback probe must reject semantically",
      );
      assert.deepEqual(JSON.parse(result.stderr), {
        ok: false,
        code: "REGISTRY_POLICY_PUBLICATION_FAILED",
        message: ROLLBACK_MESSAGE,
      });
      return { code: "REGISTRY_POLICY_PUBLICATION_FAILED", reason: "rollback_refused" };
    },
  };
}
