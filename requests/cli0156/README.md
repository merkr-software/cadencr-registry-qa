# CLI 0.15.6 QA preparation

## Status and isolation

This campaign is **not publishable yet**. `profile.json` contains explicit pending
values. All four new workflows reject that profile before fetching or executing
an ELF or exposing a publication secret.

Preparation checkout: `/tmp/cadencr-cli0156-registry-qa`.
Preparation branch: `qa/cli-0.15.6-qualification-preparation`.
Base: `84440bf005e23a8329be2f1b780f74069e1aae4d`.
The preparation checkout has no remote. No workflow dispatch, publication,
source tag creation, push, merge, production pin change, app release or database
operation is part of preparation.

The original checkout `/tmp/cadencr-cli0155-registry-qa`, root-level 0.15.5
pins, old requests, old workflows and historical incident proofs remain intact.
Shared harnesses select 0.15.5 by default; only explicit new workflows select
`QA_CLI_PROFILE=cli0156`. The new inert LSP author fixture uses **1.0.1**;
existing `qa-author-lsp@1.0.0` must never be republished or rewritten.

## Release authentication and finalization

After coordination and successful public CLI publication, download exactly these
four assets into a new private directory:

- `cadencr-v0.15.6-x86_64-unknown-linux-gnu`
- `cadencr-v0.15.6-SHA256SUMS`
- `released-cli.env`
- `provenance.json`

Use the publish run's public checksum and final source commit, independently
confirmed against the release run. A dry-run hash or source-built binary cannot
stand in for the public binary.

```sh
: "${PUBLIC_ASSETS:?Directory containing the four public release assets}"
: "${CLI_SOURCE_COMMIT:?Final public CLI source commit, 40 lowercase hex}"
: "${PUBLIC_CLI_SHA256:?Independently confirmed public ELF SHA-256}"
python3 -B scripts/cli0156/finalize.py \
  --assets "$PUBLIC_ASSETS" \
  --source-commit "$CLI_SOURCE_COMMIT" \
  --confirm-cli-sha256 "$PUBLIC_CLI_SHA256"
```

The finalizer checks bounded regular files, exact asset names, ELF64 little
endian x86_64, exact checksum/pin bytes and all provenance fields including
repository, source, release identity, release workflow, run ID and attempt. It
never executes the binary. It exclusively creates a new `released-cli.env` and
changes only the explicit pending profile. Existing outputs and a previously
finalized profile are rejected; historical pins are never replaced.

Review the concrete finalized diff and record its exact QA commit and profile
SHA-256 before coordination of push/merge/dispatch. These identifiers differ:
`profile.source_commit` is the primary CLI source; `reviewed_commit` is the exact
QA main commit containing this harness and the finalized request bytes.

## Read-only offline qualification

The dedicated `cli0156-offline.yml` fetches and independently authenticates the
public ELF and four assets. It preacquires the immutable published TypeScript
0.1.0 archive as inert data, then drops privileges and capabilities and executes
both the existing general harness and the extended LSP harness under
`unshare --net`, `setpriv --no-new-privs`, and `env -i` without credentials.
No fixture LSP, Mach-O binary or foreign-target ELF is ever executed.

| Contract | Required evidence |
| --- | --- |
| Historical behavior | Original general and LSP offline checks still pass |
| Native companion files | Data/license companions preserved, only entry executable, extra executable rejected |
| Three native targets | Complete unchanged manifest; each actual archive and tree bound by explicit `--target` and `--archive` |
| Native rejection | Global wrong-tree validation, foreign/tampered archives and invalid unselected metadata rejected |
| Entry budget | Complete typeshed-sized tree over 4096 accepted; over 16384 entries rejected |
| Node minimum | Signed optional `node_min_version` stable full semver accepted; null/type/syntax/runtime errors rejected |
| macOS minimum | Signed optional `macos_min_version` accepted only on native Darwin; null/type/syntax/platform/runtime errors rejected |
| Signature integrity | Both requirements survive signing exactly; authenticated field changes rejected |
| Omission | Existing metadata without either field round-trips unchanged |
| TypeScript baseline | All three repacks equal public SHA-256 `295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286` |

The evidence identifies CLI version, digest, source, provenance and harness.
It explicitly says native headers are synthetic, fixtures were not executed,
installation enforcement was not tested and lifecycle qualification is false.
Local source-ELF harness development is separate evidence and cannot satisfy
this public-binary qualification.

After coordination only:

```sh
: "${QA_COMMIT:?Reviewed finalized QA main commit}"
: "${PROFILE_SHA256:?SHA-256 of exact committed profile.json bytes}"
gh workflow run cli0156-offline.yml \
  --repo merkr-software/cadencr-registry-qa --ref main \
  -f reviewed_commit="$QA_COMMIT" -f profile_sha256="$PROFILE_SHA256"
```

## Inert author lifecycle

After the fixture changes have a reviewed immutable QA commit, coordinate a
**new** `qa-author-cli/<unique-0156-suffix>` tag resolving to that commit. Never
move a consumed 0.15.5 tag. The helper only checks an already existing local tag;
it never creates or pushes one.

```sh
: "${FIXTURE_COMMIT:?Reviewed immutable QA fixture commit}"
: "${AUTHOR_TAG:?New unique qa-author-cli tag already created locally}"
: "${QA_AUTHOR_ACCOUNT:?Reviewed account owning the existing QA author credential}"
python3 -B scripts/cli0156/author_candidate.py \
  --source-commit "$FIXTURE_COMMIT" --tag "$AUTHOR_TAG" \
  --expected-account "$QA_AUTHOR_ACCOUNT"
```

Review and commit the new candidate, then use its exact raw SHA-256 and new QA
main commit. First dispatch `cli0156-author.yml` with `publish=false`, then with
`publish=true` and `interrupt_draft=true` once the read-only run passes. Existing
candidate confirmation, account/repository guards, network restrictions,
byte-for-byte retries and controlled empty-draft interruption remain in use.
The signing/publishing credential is exposed only after the independent guard.

```sh
: "${CANDIDATE_SHA256:?SHA-256 of committed new author-candidate.json}"
gh workflow run cli0156-author.yml \
  --repo merkr-software/cadencr-registry-qa --ref main \
  -f reviewed_commit="$QA_COMMIT" -f profile_sha256="$PROFILE_SHA256" \
  -f candidate_sha256="$CANDIDATE_SHA256" -f publish=false -f interrupt_draft=false
# After the read-only run passes and publication coordination completes:
gh workflow run cli0156-author.yml \
  --repo merkr-software/cadencr-registry-qa --ref main \
  -f reviewed_commit="$QA_COMMIT" -f profile_sha256="$PROFILE_SHA256" \
  -f candidate_sha256="$CANDIDATE_SHA256" -f publish=true -f interrupt_draft=true
```

## Registry and policy requests: final live inputs required

Do not copy the sealed 0.15.5 requests and relabel their hashes. These new files
are intentionally absent until public author evidence and current live baselines
exist. Existing runtime guards reject missing inputs.

1. Preserve and authenticate the live `marketplace-v2` signed catalog with the
   released CLI (`verify-index --allow-expired` only for historical continuity).
   Keep its raw bytes, public QA key and existing release/asset inventory.
2. Download the exact public author metadata and both archives from the new
   release. Verify them against the 0.15.6 author-publication proof. Use its
   allowlisted `registry_plan` with Rust JSON order preserved, not a source-built
   plan or independently reserialized digest.
3. Create `requests/cli0156/incremental.json`, `lsp-submission.json`,
   `author-metadata.json`, `elf-author-offline-proof.json`, `previous.json`,
   `public.pem`, and `lsp-incremental-plan.json`. Use the existing request/plan
   shapes and guards. The plan binds every input hash, all historical archive
   coverage plus the two new target URLs, the exact mirrored entry digest, and
   only `lsp-qa-author-lsp-v1.0.1`. Discovery stays `marketplace-v2`.
4. Before any write, run `QA_CLI_PROFILE=cli0156` with the existing Node guard and
   exact dispatch environment against those concrete bytes. The new workflow
   requires the new request namespace and rejects sealed old paths.
5. Dispatch `cli0156-registry.yml`, phase `lsp-incremental`. Its first and fresh
   runners independently publish/replay and preserve all historical inventories.
6. After success, authenticate and preserve the **new** live signed index. Reuse
   `scripts/prepare-renewal.mjs` with a new local subdirectory to produce fixed
   renewal bytes, then bind `renewal.json`, `renewal-previous.json`, and
   `lsp-renewal-plan.json` in the new namespace. The plan has no publications,
   mirrors or additions, and includes all exact archive coverage. Renewal must
   preserve both `qa-author-lsp` versions `1.0.0` and `1.0.1`.
7. Dispatch `cli0156-registry.yml`, phase `lsp-renewal`, only after review of its
   exact new request/plan hashes and QA commit.
8. Create new fixed-date empty LSP policy inputs in this directory, using the
   existing `policy.json` shape and QA public key but discovery branch
   **`qa-policy-0156-lsp`**. Keep `cdn_settle_seconds=0`, whole-second UTC and the
   14-day window. Do not replace historical `qa-policy-0155-lsp` or its incident
   recovery configuration. `cli0156-policy.yml` exercises bootstrap, renewal,
   replay, rollback refusal and catalog/release immutability on the new branch.

```sh
: "${PHASE:?lsp-incremental or lsp-renewal}"
: "${PLAN_SHA256:?Exact committed new phase plan digest}"
: "${REQUEST_SHA256:?Exact committed new request digest}"
gh workflow run cli0156-registry.yml \
  --repo merkr-software/cadencr-registry-qa --ref main \
  -f reviewed_commit="$QA_COMMIT" -f profile_sha256="$PROFILE_SHA256" \
  -f phase="$PHASE" -f plan_sha256="$PLAN_SHA256" -f request_sha256="$REQUEST_SHA256"
# Separately, with the reviewed new policy request digest:
gh workflow run cli0156-policy.yml \
  --repo merkr-software/cadencr-registry-qa --ref main \
  -f reviewed_commit="$QA_COMMIT" -f profile_sha256="$PROFILE_SHA256" \
  -f profile=lsp -f request_sha256="$REQUEST_SHA256"
```

## Dependencies and parallelism

- Read-only offline qualification and inert author offline qualification may run
  in parallel once the final public profile and candidate are committed.
- Author publication precedes registry incremental planning and publication.
- Incremental publication precedes renewal planning, which needs its exact live
  result as baseline.
- Catalog mutations and policy lifecycle checks run sequentially because policy
  tests assert catalog/release immutability. Shared existing concurrency groups
  serialize writers, including old workflows. Do not bulk queue dispatches.
- Historical lost-response incident recovery remains an immutable 0.15.5 proof;
  this campaign makes no new incident-recovery claim without a real incident.
- Application installation/UI QA uses the separately attested private app
  0.16.1 environment after final feed coordination. This CLI campaign never
  authorizes app release or production LSP activation.
