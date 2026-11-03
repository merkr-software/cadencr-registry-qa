# Isolated CLI 0.15.5 LSP campaign

These are reviewed QA inputs, not completed-run evidence or production authority.
The only registry target is `merkr-software/cadencr-registry-qa` (ID `1420296872`).
Production LSP rollout remains held for application `v0.16.1`.

## Public inputs

- Released CLI source: `cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239`.
- CLI SHA-256: `b74ff1a682866902422cedfe5be0ae754a12402c4aee85fa3539ef0d30348441`.
- Inert author source tag: `qa-author-cli/stable-0155-lsp-20261103`, resolving to
  `33591d7b2f409b313fa0eadd9d1aedf709a625be`.
- Public author release ID: `433192928`; metadata and both archives were
  downloaded and checked against the verified author-publication inventory.
- Baseline discovery head: `aa65373a655893cdb1f9d338350b0e0033f40c94`.
- Baseline exact-byte SHA-256:
  `33dc7a0c75533dd953e80be1d17d85045ad9706af268b8e603e1067c64ddf59f`.

`previous.json` is a byte-for-byte copy of the live signed baseline. It expired
on 2026-11-01 and is authenticated only as historical continuity. It is never
made current by rewriting its dates. The new candidate index remains subject to
strict freshness validation.

`elf-author-offline-proof.json` comes from hosted run `41716176016`, executing
the actual distributed ELF. Its allowlisted `registry_plan` supplies the mirror
tag, package and targets, retaining the Rust output's JSON order for the exact
entry digest. No source-built plan is retained as distributed-binary evidence.

## Additive operation

The reviewed change adds exactly one inert `qa-author-lsp` version `1.0.0`,
with minimum application `999.0.0`. It never executes its JavaScript fixture.
Expected coverage changes from 26 to 27 packages and 49 to 51 distinct archives.
Every historical package, archive, release ID and asset ID must be preserved.

The workflow exercises publication, same-state replay and a separate fresh
runner. This registry campaign injects no failure and makes no interruption or
lost-response recovery claim. The distinct author campaign supplies its actual
controlled empty-draft interruption evidence.

## Policy operation

The empty `lsp-blocklist` uses only the new `qa-policy-0155-lsp` branch and the
existing dedicated QA signing authority. The workflow must observe no existing
feed before bootstrap, then verify publication, renewal, replay and rollback
refusal. Run it separately from catalog mutations, because it also asserts that
catalog and release inventories stay unchanged.

Dates in the requests and payload were fixed from the actual UTC preparation
time and independently reviewed. They must not be regenerated to manufacture
recovery after a failed operation. Preserve original inputs and inspect any real
failure before deciding how to resume.
