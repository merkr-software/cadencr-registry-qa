# Held real Node LSP seed

This manual QA workflow prepares a real `typescript-language-server` candidate.
It does not create releases, tags, submissions, signed catalogues or policies,
and does not activate any production feed. Package visibility remains held for
Cadencr `0.16.1`.

## Locked sources and compatibility

| Component | Exact version | Source commit | Runtime requirement |
| --- | --- | --- | --- |
| TypeScript language server | `5.3.0` | `589044479e4bc2bffb796b593242136f5323b582` | Node `>=20` |
| TypeScript | `6.0.3` | `050880ce59e30b356b686bd3144efe24f875ebc8` | Node `>=14.17` |

Both official npm tarballs and every extracted file are locked in
`source-lock.json`: tarball sizes, SHA256, npm SHA512 integrity, file names,
sizes and SHA256. The complete distributions contain 145 regular files and
26,682,278 bytes. No npm command, shim, build or lifecycle script runs.

Source licenses and notices remain in the payload, including the TLS Apache2
license and copied Microsoft MIT notice, plus TypeScript's license and third
party notices. npm integrity is verified; this workflow does not independently
verify npm registry signatures or Sigstore provenance.

The package version is `0.1.0`, with `min_app_version: 0.16.1`. Signed arguments
are `--stdio`; automatic typing acquisition is disabled. The package uses an
existing Node installation. Node `22.19.0` is the exact smoke runtime. The
current package contract does not encode a signed minimum Node version, so
Node `>=20` remains an explicit prerequisite.

Do not replace versions with `latest`: TLS6 requires Node `>=22.22.2`, and
TypeScript7 uses a different native distribution rather than the bundled
TypeScript6 `tsserver` layout.

## Dispatch and trust boundaries

The workflow accepts only:

- Repository `merkr-software/cadencr-registry-qa`, numeric ID `1420296872`.
- A manual `workflow_dispatch` on `refs/heads/main`.
- Its exact workflow path on `main` and the dispatched SHA equal to
  `reviewed_commit`.
- Exact reviewed SHA256 inputs for this source lock and `lsp-cli-pin.env`.
- Released CLI `0.15.5`, pinned binary digest, x86_64 ELF format and official
  provenance bound to source commit
  `cfbb3b0d7c94a5d0fe91a3a642c5c1debf917239`.

`scripts/fetch-cli0155.sh` downloads and authenticates the released CLI without
executing it. Source downloads and extraction occur before entering the network
namespace. Execution then uses `unshare --net`, a non-root UID, cleared groups,
no capabilities, no new privileges and `env -i`. The runtime verifies these
properties itself. No source-built CLI fallback exists in `prepare.py`.

The three dispatch inputs are `reviewed_commit`, `source_lock_sha256` and
`pins_sha256`. Compute digests from the exact reviewed files; do not copy an old
digest after editing them.

## Checks and artifact contents

1. Recheck the complete prepared source tree against the reviewed lock.
2. Run real LSP initialize, bundled-TypeScript selection, semantic diagnostic
   `TS2322`, hover and graceful shutdown under Node `22.19.0`.
3. Package each of `darwin-aarch64`, `darwin-x86_64` and `linux-x86_64` twice
   through the exact released CLI and require byte-identical output.
4. Independently inspect archive membership, regular files, modes, normalized
   metadata, per-file digests and receipt archive/entry digests and sizes.
5. Validate the candidate manifest with `plugin validate --kind lsp`.

Only explicitly named archives, the candidate manifest, lock, public pin and
provenance, inventory, receipts and sanitized evidence are uploaded. Private
scratch, temporary home/workspace, downloads, stderr and logs are excluded.
The workflow does not use keys or publication credentials.

Manifest URLs refer to the planned CadencR release tag
`lsp-typescript-language-server-v0.1.0`. That release is not created. These URLs
are planning metadata, not evidence of existing remote artifacts. No fictitious
`submission.source.commit` is generated.

Linux workflow execution qualifies only the current Linux x86_64 upstream
runtime. The two macOS archive targets express the portable Node contract;
they do not prove Intel Mac or Apple Silicon runtime qualification. Cadencr
installation, UI, revocation and packaged-client checks remain separate.

## Local checks

Run the adversarial extraction, lock, metadata and guard tests without network:

```sh
python3 -B scripts/lsp-node-seed/test_seed.py
```

The explicitly named local helper exercises locked cached npm tarballs and an
already built source CLI. It has no role in the released-ELF workflow, does not
bypass `prepare.py`'s isolation checks and labels evidence `local-source-only`:

```sh
python3 -B scripts/lsp-node-seed/local_check.py \
  --cli /absolute/source-built/cadencr \
  --node /absolute/node22.19.0/bin/node \
  --lock /absolute/qa/scripts/lsp-node-seed/source-lock.json \
  --tarballs /absolute/verified-npm-tarballs \
  --output /absolute/new-local-evidence-directory
```

The cache must contain `typescript-language-server-5.3.0.tgz` and
`typescript-6.0.3.tgz`; the same production extractor verifies their complete
locked integrity before use. Source CLI `0.15.5` is required. Local macOS smoke
does not establish Linux distributed-CLI qualification.
