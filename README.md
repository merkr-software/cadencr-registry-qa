# Isolated public registry QA

- Canonical repository: `merkr-software/cadencr-registry-qa` only. No production pins or repositories.
- `workflow_dispatch` only, exact default-branch commit and reviewed request SHA-256.
- Uses only distributed CLI `0.13.1-dev.38974097824.1`, verified by the committed SHA-256; no build/fallback.
- Only QA job has repository-scoped `contents: write`; no host OAuth credential.
- Secret `QA_SIGNING_KEY_PEM` must be the distinct QA-only Ed25519 PKCS8 key matching `requests/public.pem`.

## Prepare and review

1. The inert source release, submission, dedicated QA key and managed draft already exist. Preserve their immutable tags, release/asset IDs and the committed `requests/initial.json`; do not recreate them.
2. Review the harness commit and initial request SHA-256. The old `prepare-initial.mjs` is only the historical bootstrap helper; do **not** rerun it for this retained-draft lifecycle, because it lacks the publication-level commit binding. Provision `marketplace-v2` from the reviewed QA harness commit if absent.
3. Dispatch `initial` with that commit and digest. Two serial, clean runners publish/replay the same immutable request. They do not restore Actions artifacts. Only allowlisted public receipts are uploaded; pipeline state is never restored.
4. Download and authenticate the published signed index with the pinned CLI. Run `node scripts/prepare-renewal.mjs INDEX GENERATED_AT EXPIRES_AT requests` locally to create byte-identical `previous.json` and fixed `renewal.json` (empty publication delta, newer dates, at most 14 days validity). Review and commit these bytes, then dispatch `renewal` with exact new commit/digest. The helper checks shape, not signatures; authentication is mandatory first.
5. Inspect public release assets, discovery branch, receipt artifact and summary. Renewal must retain the exact package set. A later date requires a new reviewed request, never runtime regeneration.

## Evidence and boundaries

- Each runner executes publish and same-state replay. The other runner begins without any local pipeline state, exercising remote reconstruction.
- The workflow asserts final catalog/discovery receipt statuses and retains only allowlisted public receipts, inventory and signed catalog bytes. Artifacts are never recovery authority.
- CLI performs signature, public-byte, binding and tag verification. Known source/managed release and asset IDs are asserted. Every previously public release is preserved; replay and fresh-runner inventories must be identical.
- No interrupted-process claim: killing the CLI can leave locks; do not remove locks/state to manufacture success. A separately reviewed fault mechanism is required.
- No local state or databases are removed. Only the materialized secret is deleted, outside artifact paths.
- The dedicated QA secret and inert source release are already provisioned; the existing draft is resumed, not recreated. The discovery branch must exist before dispatch.

## Fixture provenance

QA ONLY: not an official plugin release. Declarative Graphite theme fixture from `merkr-software/CadencR` at commit `24d0bea0eaffc56122f832c8413a8c6bbf40da3d`. Archive retained byte-identically: SHA-256 `feb4ba028cbb4abf9014284322d7920ad647e7c26318db586c8a50d9326ceb17`, 1100 bytes. Source license is preserved in `fixtures/LICENSE`. QA package identity is `qa-inert-theme`, version `0.0.1`; source release tag is `qa-source-theme-v0.0.1`.

## Reviewed binding

- Initial publication stays bound to existing managed draft commit `69b919e5f9e0162a55e10873e495829c05bcae13`; top-level catalog binding uses the new exact reviewed workflow commit.
- Guard requires default branch `main`, exact dispatch commit/digest and runner `first` or `fresh`. Runtime checks pinned binary digest/version before materializing the existing signing secret.
- Existing source/managed releases, tags and assets must not be recreated or overwritten. This harness update alone does not qualify the lifecycle.
