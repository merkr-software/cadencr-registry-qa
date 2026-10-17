# Distributed original-author CLI qualification

## Boundary

- QA orchestration only: production packaging/publication rules remain in the
  released Rust CLI and shared Rust libraries. No source-built fallback.
- Fixed public target: `merkr-software/cadencr-registry-qa`, numeric repository
  ID `1420296872`. No registry submission, signing or official plugin publication.
- The theme is inert declarative data derived from Graphite. See `PROVENANCE`
  and the preserved Apache-2.0 `LICENSE`.

## Reviewed inputs

Deploy `workflow.yml` as `.github/workflows/author.yml` in the QA repository,
alongside the harness, fixtures and reviewed released-CLI fetcher. Keep the
existing registry QA workflow, signing secret and registry CLI pin unchanged.

| File                        | Required binding                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `author-cli-candidate.json` | Exact CLI version/checksum, fixed public repository/ID, user account, unique `qa-author-cli/<suffix>` tag and full source commit |
| `author-cli-pin.env`        | The same released version/checksum and `cli/v<version>` tag; parsed as data, never sourced                                       |
| Candidate source commit     | Existing QA tag points here; tracked theme bytes match the harness fixture                                                       |
| Dispatch                    | Reviewed workflow commit equals `github.sha`; exact candidate-file SHA-256                                                       |

Create the source commit and unique QA tag first, then commit the candidate and
pin referencing it. Never move an existing tag or overwrite release assets.

## Runs and credentials

1. Dispatch with `publish=false`. A clean Linux runner fetches the exact public
   ELF, then runs local validation, canonical packaging, inspection and wrong
   confirmation rejection without network access or inherited credentials.
2. Only after that succeeds, dispatch with `publish=true` and, for a fresh tag,
   `interrupt_draft=true`. The final step alone receives a separately approved
   user-associated `QA_AUTHOR_GITHUB_TOKEN`. The automatic Actions token cannot
   authenticate the author's `/user` identity.
3. Verify exact immutable public asset bytes, then same-state and fresh-scratch
   retries. Changed assets/requests must fail with the expected CLI diagnostic
   and leave the independently verified remote inventory unchanged.

The optional TLS-blind proxy holds the upload connection, observes an empty
bound draft, terminates only its owned CLI child, then resumes the exact request
and requires the same release ID. This proves **draft interruption/recovery**,
not arbitrary lost-response recovery.

## Evidence and limits

- Upload only the explicit public proof JSON, never the scratch directory,
  subprocess output, environment, credentials or keys.
- Scratch is intentionally retained. Never recursively remove it: an unexpected
  Cadencr database must not be deleted.
- Unit tests use synthetic processes/network observations. They do not qualify a
  distributed executable; record real workflow and release evidence separately.
- QA success does not promote production pins/policies or enable marketplace UI.

## Local harness tests

```sh
node --test scripts/qualify-author-cli.test.mjs scripts/author-cli-qa-workflow.test.mjs
```
