# Public CLI 0.15.6 qualification evidence

The successful workflows below executed the authenticated public Linux ELF, not a source or dry-run replacement. `manifest.json` binds every retained raw proof; `workflow-artifacts.json` binds the original GitHub ZIP IDs and SHA-256 digests verified before extraction.

- Public CLI source: `33abe673179a889c7ec362da2e9845166de1ac34`.
- Inert author fixture source: `3ad1af383861c4d4a97222847c65a947d625b5ae`.
- QA workflow/request commits are recorded separately per file and artifact.
- General offline: 91 checks; LSP offline: 129 checks, including synthetic ELF/Mach-O headers. Fixture servers and foreign-target binaries were never executed.
- Author publication tested empty-draft interruption, exact resume, retries, changed-input refusal, and a distinct fresh-runner replay with identical release/asset IDs.
- Registry incremental and renewal each tested first/fresh runners and same-state replays. Renewal retained all 28 entries and 53 archive URLs.
- The empty LSP policy tested bootstrap, renewal, replay, rollback refusal, and unchanged catalog/release inventories.

Initial policy run `42210723838` failed before publication because its dedicated discovery branch did not exist. After an authenticated 404 and confirmation that no policy file existed at reviewed QA commit `d19cbf58949ecef6b5578518d4dc2fed58f929a2`, only the new `qa-policy-0156-lsp` branch was created at that commit. Run `42210995535` then passed using unchanged request/payload bytes. The failed proof and branch-creation receipt remain retained. A new policy discovery branch must exist before this bootstrap harness is dispatched.

All 187 protected historical 0.15.5 files, the original checkout, and historical releases/tags remain preserved. Registry and policy writers ran serially. This evidence does not authorize an app release or production activation and does not qualify native LSP runtime behavior or installation enforcement; those require separate application/runtime checks.
