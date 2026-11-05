// The 0.15.5 default profile stays unchanged. New workflows explicitly select this profile.
import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
export function profile0156(root = process.cwd()) {
  const file = path.join(root, "requests/cli0156/profile.json");
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096);
  const value = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(value).sort(), ["schema_version", "status", "repository", "version", "tag", "source_commit", "cli_sha256", "run_id", "run_attempt"].sort());
  assert.equal(value.schema_version, 1);
  assert.equal(value.status, "FINALIZED_PUBLIC_RELEASE", "CLI0156_PROFILE_PENDING");
  assert.equal(value.repository, "merkr-software/CadencR");
  assert.equal(value.version, "0.15.6");
  assert.equal(value.tag, "cli/v0.15.6");
  for (const [field, pattern] of [["source_commit", /^[a-f0-9]{40}$(?![\s\S])/], ["cli_sha256", /^[a-f0-9]{64}$(?![\s\S])/], ["run_id", /^[1-9][0-9]*$(?![\s\S])/], ["run_attempt", /^[1-9][0-9]*$(?![\s\S])/]]) {
    assert.equal(typeof value[field], "string");
    assert.match(value[field], pattern);
  }
  return value;
}
