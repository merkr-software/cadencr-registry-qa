import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep, dirname, join } from "node:path";
import { profile0156 } from "../cli0156/profile.mjs";
import { profile0157 } from "../cli0157/profile.mjs";
import { validateProfile } from "./profiles.mjs";
export const REPOSITORY = "merkr-software/cadencr-registry-qa";
assert.ok(process.env.QA_CLI_PROFILE === undefined || ["cli0156", "cli0157"].includes(process.env.QA_CLI_PROFILE), "unknown CLI profile");
const profileId = process.env.QA_CLI_PROFILE;
const active = profileId === "cli0157" ? profile0157() : profileId === "cli0156" ? profile0156() : null;
export const VERSION = active?.version ?? "0.15.5";
export const BINARY_SHA = active?.cli_sha256 ?? "b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function file(path, max = 4194304) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max);
  return readFileSync(path);
}
export function local(path) {
  assert.equal(typeof path, "string");
  assert.ok(!path.split(/[\\/]/).includes("..") && !path.startsWith("/"));
  assert.ok(resolve(path).startsWith(process.cwd() + sep));
  return path;
}
export function guard(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, "1420296872");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.QA_DEFAULT_BRANCH, "main");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.REVIEWED_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_COMMIT);
  assert.ok(["first", "fresh"].includes(env.QA_RUNNER));
  for (const key of ["REQUEST_SHA256", "PLAN_SHA256"])
    assert.match(env[key] ?? "", /^[a-f0-9]{64}$/);
  if (active) {
    assert.equal(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/.github/workflows/${profileId}-registry.yml@refs/heads/main`);
    assert.equal(sha(file(`requests/${profileId}/profile.json`, 4096)), env[profileId.toUpperCase() + "_PROFILE_SHA256"]);
    assert.ok(env.QA_PLAN.startsWith(`requests/${profileId}/`), "profile must not reuse sealed requests");
  }
  const planBytes = file(local(env.QA_PLAN));
  assert.equal(sha(planBytes), env.PLAN_SHA256);
  const plan = JSON.parse(planBytes);
  assert.ok(["incremental", "renewal"].includes(plan.phase));
  const requestBytes = file(local(plan.request));
  assert.equal(sha(requestBytes), env.REQUEST_SHA256);
  const request = JSON.parse(requestBytes);
  assert.equal(request.repository, REPOSITORY);
  assert.equal(request.schema_version, 2);
  assert.equal(request.discovery_branch, "marketplace-v2");
  assert.notEqual(request.previous_index, "bootstrap", "never reset the existing feed");
  assert.equal(sha(file(local(plan.previous))), plan.previous_sha256);
  assert.equal(sha(file(local(plan.public_key))), plan.public_key_sha256);
  assert.equal(resolve(plan.public_key), resolve(dirname(plan.request), request.public_key));
  assert.equal(resolve(plan.previous), resolve(dirname(plan.request), request.previous_index));
  assert.equal(request.key_id, plan.key_id);
  const submissions = [];
  for (const publication of request.publications) {
    const path = local(join(dirname(plan.request), publication.submission));
    assert.ok(Object.hasOwn(plan.inputs, path), "every submission must be hash-bound");
    submissions.push(JSON.parse(file(path)));
  }
  for (const [path, digest] of Object.entries(plan.inputs))
    assert.equal(sha(file(local(path))), digest);
  const previous = plan.profile ? JSON.parse(file(local(plan.previous))) : undefined;
  validateProfile(plan, request, submissions, env.QA_PHASE, previous);
  if (plan.fault) {
    const faultSubmission = local(plan.fault.submission);
    assert.ok(Object.hasOwn(plan.inputs, faultSubmission));
    assert.equal(JSON.parse(file(faultSubmission)).package.kind, "theme");
    assert.ok(plan.mirror_tags.includes(plan.fault.tag));
    const theme = JSON.parse(file(faultSubmission)).package.package.theme;
    assert.equal(plan.fault.tag, `theme-${theme.id}-v${theme.version}`);
  }
  if (env.QA_RUNNER === "fresh")
    assert.match(env.QA_EXPECTED_INVENTORY_SHA256 ?? "", /^[a-f0-9]{64}$/);
  return { plan, request };
}
if (process.argv[1] === new URL(import.meta.url).pathname) guard();
