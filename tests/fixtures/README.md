# Host CLI fixtures

## `settings-sync-vectors.json`

These runtime-neutral vectors define the settings-sync host merge and plaintext
parse contract. Core's `syncMerge.test.ts` runs them directly. Desktop, web,
and Android contract tests should load the same file from their pinned core
source rather than copy the expected values. Its `fixtureSchemaVersion` is
test-fixture metadata only; it is not added to the versionless `{ "hosts": [] }`
wire payload. See [`docs/SYNC.md`](../../docs/SYNC.md) for field ownership,
selection/deletion, and versioning rules.

## `pocketshell-0.5.8/`

These response and stderr fixtures were captured from the real Docker helper
image with the published `pocketshell==0.5.8` CLI, not constructed from a
TypeScript model. `Dockerfile.helper` pins this release and the integration
suite invokes the same CLI over SSH. Capture setup:

- `sessions-list.json`: the helper entrypoint's seeded `testuser:main` and
  `testuser:build` sessions.
- `sessions-list-errors.json`: same list with `APLEXER_BIN=/does/not/exist`
  to preserve the CLI's non-empty `errors` response.
- `sessions-create-existing.json`: create `main` again, which returns success
  with `created: false`.
- `sessions-create-error.json`: create in an image without `systemd-run`,
  preserving its structured JSON error and non-zero exit.
- `workspaces-list-empty.json`, `workspaces-add.json`, and
  `workspaces-remove.json`: actual empty/add/remove responses from one
  `workspaces add` / list / remove sequence.
- `engines-list.json` and `profiles-list-empty.json`: actual host catalog
  responses; the helper's `grok` engine is unavailable and the host has no
  configured profiles.
- `sessions-warnings.stderr.txt` and `sessions-ack.stderr.txt`: actual exit-2
  stderr for commands not included in published CLI 0.5.8.

The `sessions-warnings-reference.json` fixture in
`host-cli-current-source/` is a source contract fixture copied from Android's
host API tests. It pins parsing and selector rules for the newer warnings
command, but it is not represented as output from the published 0.5.8 Docker
image. Do not change these version labels or turn unsupported-command failures
into success-shaped empty values until a new published CLI is pinned and
captured.
