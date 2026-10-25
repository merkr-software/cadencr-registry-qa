# Distributed registry CLI QA orchestration

## Deployment (not performed by these files)

- Deploy this directory and `workflow.yml` as `.github/workflows/qa.yml` in **only** `merkr-software/cadencr-registry-qa` (repository ID `1420296872`). Never reset the existing discovery branch or remove a release.
- Retain existing `scripts/fetch-released-cli.sh`; update reviewed `cli-pin.env` to version `0.13.1-dev.39108033875.1`, SHA-256 `d11bfade6297fa30e1e10e82605f5a221da8e07edeeee372e2c2f6185c6ff725`, tag `cli/v0.13.1-dev.39108033875.1`. Source provenance is `88ead507983371e5c3df468c6d9bf7c6c12e5fbb`; never build a substitute.
- Retain exact old QA `scripts/fault-driver.mjs`, `fault-proxy.mjs`, and `evidence.mjs`. They are dynamically imported only after checksum validation. These are deployed dependencies, not copied implementations.
- Workflow pins checkout `3d3c42e5aac5ba805825da76410c181273ba90b1` and upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`.
- Review the exact deployed workflow commit, request hash and plan hash before dispatch. Both runner jobs guard these before secret-bearing steps. Configure existing QA signing secret only in the isolated public QA repository.

## Reviewed plan format

Supply `requests/incremental-plan.json`, later `requests/renewal-plan.json`. Paths are checkout-relative; request-internal paths are request-relative. The plan is itself hash-bound by dispatch input `plan_sha256`.

```json
{
  "phase": "incremental",
  "request": "requests/incremental.json",
  "previous": "requests/previous.json",
  "previous_sha256": "REVIEWED_SHA256",
  "public_key": "requests/public.pem",
  "public_key_sha256": "REVIEWED_SHA256",
  "key_id": "qa-2026",
  "inputs": { "requests/provider-submission.json": "REVIEWED_SHA256" },
  "mirror_tags": ["EXACT_PROVIDER_TAG", "EXACT_THEME_TAG", "EXACT_TAB_TAG"],
  "added_entry_sha256": ["EXACT_ENTRY_SHA256", "EXACT_ENTRY_SHA256", "EXACT_ENTRY_SHA256"],
  "archives": [
    {
      "url": "https://github.com/merkr-software/cadencr-registry-qa/releases/download/EXACT_TAG/ARCHIVE",
      "sha256": "REVIEWED_SHA256",
      "size": 123
    }
  ],
  "fault": {
    "submission": "requests/theme-submission.json",
    "tag": "EXACT_TAG",
    "sha256": "REVIEWED_SHA256",
    "size": 123
  }
}
```

- Include **all three** submissions and all externally reviewed fixture inputs in `inputs`. Entry expectations must come from the actual CLI-generated catalog, not an assumed wrapper (provider entries may serialize unwrapped). Entry hashes are SHA-256 of UTF-8 `JSON.stringify(entry)` in the signed package envelope, without newline. This is exact fixture expectation, not catalog construction.
- `archives` must exactly cover every distinct archive URL/digest in the authenticated catalog, including historical entries, with exact public mirror URLs/size/digest. Both authenticated signed envelopes are verified by the pinned CLI; independently fetched anonymous catalog/archive bytes must match the reviewed expectation.
- Renewal uses `phase: renewal`, an empty publication delta, empty `mirror_tags`/`added_entry_sha256`, no `fault`, and the newly authenticated mixed catalog as baseline. It must advance both generation and expiry timestamps without changing packages.
- `fault` reuses the existing TLS-blind controlled interruption driver. The selected fixture must be a theme (`theme.tar.gz`, the existing driver sentinel); the selected tag must not exist yet; sentinel is a public release/archive, followed by injected transport interruption and process-exit/lock checks. Same-state resume must retain observed release/asset IDs.

## Proof and limits

- Only signed public catalog envelopes and explicitly constructed key-free proof objects are uploaded. Raw CLI output and private pipeline state are never uploaded; bounded normal child output is captured and discarded.
- All existing releases (including drafts visible to the job token) and assets are inventoried before/after, comparing IDs, asset size/digest and update timestamps. Replays must leave inventories identical. Fresh runner receives only the inventory digest, never prior state/artifacts.
- Reads are bounded to 60 seconds and 16 MiB; inventory fails closed beyond 1,000 releases or 99 assets/release. Normal CLI execution is capped at 15 minutes/1 MiB output. Existing fault driver has its own finite observation/exit deadlines and intentionally fails inconclusive without killing a potentially mutating publisher; workflow job timeout is the final outer bound.
- Twelve local synthetic tests cover guard rejection, inventory preservation, renewal continuity, HTTP size/deadline, process deadlines, stale-baseline rejection, fresh first-attempt immutability, exact archive coverage, and bounded concurrent inventory pagination/abort. They do **not** establish published-CLI distributed qualification. No remote mutation or dispatch was performed during authoring.

## Dependency checksums

| Existing QA helper         | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `scripts/fault-driver.mjs` | `bc714592e717c12e1d992d7d04e85eb791f14022391b8db52b5998a7ebdf4da9` |
| `scripts/fault-proxy.mjs`  | `f85bf7807edcf3e14f8a2e79c8a4d6322ed8c3ff19c962e67ebc1ac96c941338` |
| `scripts/evidence.mjs`     | `57ff31556ee87708a8fcb197e635513e4ee3fc0013d91c1131fd0648836471ba` |

## Review refinements

- Authenticated inventory now includes discovery head, blob, and decoded catalog SHA-256; the shared checksum-bound `waitForObservation` retries under one 60-second signal. Post-publication acceptance requires exact receipt blob/snapshot agreement and an independent anonymous raw discovery fetch. Immutable release drift fails immediately; replay also binds the head.
- Version/signature subprocesses receive only a minimal environment allowlist. Only publication/fault subprocesses receive the job token; no subprocess inherits signing-key environment text.
- First incremental runs reject any pre-existing managed fixture tag, including drafts. Unrelated historical drafts remain strictly preserved rather than implicitly claimed by this run.
- JavaScript is retained intentionally to import the reviewed existing QA fault/convergence helpers without a second orchestration runtime or copied publication business logic.
- The theme-checkpoint interruption exercises recovery of the mixed pipeline; it does not prove mutation-response loss independently for each kind.

- Before creating signing-key material or publishing, the first job requires live discovery bytes to match the reviewed previous catalog digest. A stale reviewed baseline is rejected rather than silently replacing a newer feed. The fresh runner instead binds to the first job's final inventory hash; its very first publication attempt must preserve that complete inventory, including discovery head.
- Anonymous archive checks require exact URL/digest coverage of the authenticated catalog's provider binary targets and theme/tab distributions. Omissions, duplicates and unrelated extras are rejected; reviewed sizes remain independently checked against downloaded bytes.
- Asset inventory uses at most four concurrent reads under the same 60-second inventory signal, with deterministic sorted results and fail-closed asset pagination. ELF architecture/header validation reuses the checksum-bound existing QA helper rather than duplicating a weaker header check.

## Revocation policy lifecycle (`policy.yml`)

- QA ONLY. One `workflow_dispatch` job on `main` guards the exact reviewed commit and `requests/stable-0150-20261025/policy.json` SHA-256 before any secret is read, fetches the pinned released ELF, and only the final step receives `QA_SIGNING_KEY_PEM`.
- The request binds three inert empty-entries payloads (provider, theme, tab) and the QA public key by SHA-256. Payload dates are committed bytes; only the renewal generation time comes from the CLI's own clock.
- The job signs and verifies each policy, bootstraps `managed-blocklist.json`, `managed-theme-blocklist.json` and `managed-tab-blocklist.json` on `marketplace-v2`, renews from an authenticated `fetch-policy` baseline, publishes with `--renewal`, replays (must be `unchanged` with no branch write) and attempts a rollback (must be refused with no branch write).
- It refuses to start if any policy file already exists; it never deletes or resets the discovery branch. The catalog and release inventory must be unchanged by the policy lifecycle.
- Uploaded artifacts: a strict key-free proof, the sanitized failure record, and the public signed envelopes.
