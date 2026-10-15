# Isolated public registry QA

- Canonical repository: `merkr-software/cadencr-registry-qa` only. No production pins or repositories.
- `workflow_dispatch` only, exact default-branch commit and reviewed request SHA-256.
- Uses only distributed CLI `0.13.0`, verified by the committed SHA-256; no build/fallback.
- Only QA job has repository-scoped `contents: write`; no host OAuth credential.
- Secret `QA_SIGNING_KEY_PEM` must be the distinct QA-only Ed25519 PKCS8 key matching `requests/public.pem`.

## Prepare and review

1. Parent commits this harness and inert source, then creates QA-only immutable source tag/release with `fixtures/theme.tar.gz` as asset `theme.tar.gz`. Source archive contains only inert theme JSON, no executable. Original visual label is Graphite; registry package identity is `qa-inert-theme`, not an official theme publication.
2. Run `node scripts/prepare-initial.mjs SOURCE_COMMIT qa-source-...` locally. This exclusively creates fixed request/submission bytes for review. Commit them; record exact commit and request SHA-256.
3. Dispatch `initial` with that commit and digest. Two serial, clean runners publish/replay the same immutable request. They do not restore Actions artifacts. Only allowlisted public receipts are uploaded; pipeline state is never restored.
4. Download and independently verify the published signed index, commit it as `requests/previous.json`; prepare `requests/renewal.json` with same repository/key/schema/branch, `previous_index: "previous.json"`, `publications: []`, newer fixed dates (at most 14 days validity). Review and commit these bytes, then dispatch `renewal` with exact new commit/digest.
5. Inspect public release assets, discovery branch, receipt artifact and summary. Renewal must retain the exact package set. A later date requires a new reviewed request, never runtime regeneration.

## Evidence and boundaries

- Each runner executes publish and same-state replay. The other runner begins without any local pipeline state, exercising remote reconstruction.
- The workflow asserts final catalog/discovery receipt statuses and retains only allowlisted public receipts, inventory and signed catalog bytes. Artifacts are never recovery authority.
- CLI performs signature, public-byte, binding and tag verification. Independent receipt/package comparison remains a reviewer check.
- No interrupted-process claim: killing the CLI can leave locks; do not remove locks/state to manufacture success. A separately reviewed fault mechanism is required.
- No local state or databases are removed. Only the materialized secret is deleted, outside artifact paths.
- This scaffold cannot run until reviewed source release, committed requests and explicitly authorized secret provisioning exist.

## Fixture provenance

QA ONLY: not an official plugin release. Declarative Graphite theme fixture from `merkr-software/CadencR` at commit `24d0bea0eaffc56122f832c8413a8c6bbf40da3d`. Archive retained byte-identically: SHA-256 `feb4ba028cbb4abf9014284322d7920ad647e7c26318db586c8a50d9326ceb17`, 1100 bytes. Source license is preserved in `fixtures/LICENSE`. QA package identity is `qa-inert-theme`, version `0.0.1`; source release tag is `qa-source-theme-v0.0.1`.
