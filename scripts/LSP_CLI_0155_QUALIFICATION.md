# CLI 0.15.5 LSP qualification

This harness prepares isolated evidence for CLI `0.15.5`. Cadencr application
releases and production LSP catalogue or feed activation are outside its scope.
Production LSP rollout is reserved for application `v0.16.1`.

## Exact binary

The expected source is `cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239` in
`merkr-software/CadencR`. `lsp-cli-pin.env` and `author-cli-pin.env` must contain
the exact public `released-cli.env` bytes from `cli/v0.15.5`, after the release
has been published and independently inspected. A source-built CLI never
substitutes for that distributed Linux ELF in hosted qualification.

`fetch-cli0155.sh` only downloads and authenticates assets. It never executes
the downloaded binary. Offline execution happens inside a network namespace,
with an empty environment and dropped privileges.

## Offline gates

Dispatch `lsp-offline.yml` on QA `main` with:

- `reviewed_commit`: exact QA commit containing the reviewed workflow and pins;
- `pins_sha256`: SHA-256 of the exact `lsp-cli-pin.env` bytes;
- `source_commit`: the source commit above.

The workflow runs the existing general offline harness and the new LSP
supplement against the same downloaded ELF. Only their key-free JSON evidence
is retained. Existing historical qualification records remain unchanged.

The LSP supplement inspects actual archive contents, deterministic bytes,
metadata and rejection boundaries, mixed-index signatures, and LSP policy
signatures and domain separation. Native fixtures contain synthetic ELF/Mach-O
headers and are never executed. They establish no native runtime conformance.
Offline policy tests establish no client install or launch enforcement.

## Inert author lifecycle

The author harness now admits `kind: "lsp"`, while retaining the fixed QA
repository/account guards and exact candidate digest confirmation. Its prepared
Node fixture always throws if executed and has compatibility `999.0.0`.

Create a new immutable fixture source tag before committing the candidate that
names it. Never move an earlier source tag or replace a public release.

Run the author workflow offline first. Then use a new tag for one public QA run
with controlled empty-draft interruption, followed by a separate fresh-runner
dispatch. Compare the public release and asset inventories exactly. Author
publication does not publish any production discovery catalogue.

## Local development checks

Local source-built CLI smoke checks and fake-transport tests validate the test
harness only. They are not distributed-ELF qualification. Real publication,
interruption, fresh-runner recovery and functional server checks require their
own successful hosted evidence; this document claims none before those runs.
