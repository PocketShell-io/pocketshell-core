# @pocketshell/core — Testing

Two tiers, plus the embed check. The guiding rule is inherited from the
desktop and Android projects: **only deterministic Docker targets, never
real hosts or real provider credentials.**

| Tier | Runner | Target | Covers | When |
|---|---|---|---|---|
| **Unit** | vitest (node) | none (pure logic) | the ported contract suites: parsers, quoting, sync merge, verdicts | every push |
| **Integration** | vitest + `testcontainers` | ephemeral Docker port per test | `AplexerCore`, `HostCliCore`, SFTP, and known-hosts verdicts — against real sshd/sftp/`a`/`pocketshell` | every push (requires Docker) |
| **Embed check** | `npm run embed` | Node `vm` + real QuickJS | the IIFE bundle answers contract assertions in both engines | every push |

## Unit

`npm run test:unit`. Pure TypeScript, no network, no Docker, <2s. These are
the contract suites ported from desktop + web when the package was created;
they pin bytes → data transformations to fixture shapes.

## Integration

`npm run test:integration` — the same tier, shape for shape, as
pocketshell-desktop's `tests/integration`. `testcontainers` starts ephemeral
containers from the prebuilt `pocketshell-test:*` tags and maps container 22
to an ephemeral host port, so suites are isolated and parallel-safe.

The fleet lives in `tests-docker/` and is a **byte-identical copy** of the
desktop fleet (which mirrors the Android project's) — a `pocketshell-test:*`
tag must mean the same machine no matter which project built it. Build the
tags once with:

```bash
npm run build-docker   # ssh → tmux → helper, in layer order
```

Docker is a required prerequisite; collection fails loudly when the daemon is
unavailable (`describeDocker`), because a suite that ran nothing must never
report a green tick. Suites:

- **AplexerCore** (`pocketshell-test:helper`): the availability probe, the
  seeded `main`/`build` snapshot listing, the stable-selector discipline
  (UUID across a rename), the start → find → rename → kill round trip, the
  stale-list `notFound` race, and totality (`listWarnings` never throws).
  The transport is core's one-method `exec` interface adapted to ssh2 — the
  same seam the desktop's SshService and the web's connection object sit in.
- **HostCliCore** (`pocketshell-core-test:helper`, pinned
  `pocketshell==0.5.8`):
  reads the seeded session list, verifies create idempotency and kill, runs a
  quote/newline/Unicode/shell-injection workspace round trip, and reads the
  real engine and profile catalogs. Captured response fixtures are under
  `tests/fixtures/pocketshell-0.5.8/`; their commands and setup are documented
  in that directory. The core-owned alias avoids collisions with Android and
  desktop builds that share the generic `pocketshell-test:helper` tag; each
  HostCliCore test checks the running CLI's version before invoking it. This
  release does not publish `sessions warnings` or
  `sessions ack`: Docker verifies those verbs fail with the real CLI's exit
  code and stderr, while a source/reference fixture pins the parser shape for
  the newer warning schema. A successful Docker path for those verbs requires
  a later published CLI release and a deliberate fixture pin update.
- **SftpCore** (`pocketshell-test:ssh`): REAL readdir/stat output through
  `toDirEntry`/`toFileStat` — the exact mapping desktop's SftpService runs —
  plus a write → read-back byte-equality check, an exact-size stat, and the
  dir/file/symlink classification of one listing.
- **KnownHostsCore** (`pocketshell-test:ssh`): the raw host-key blob from a
  real handshake decoded by `decodePublicKeyBlob`, then the TOFU ladder —
  `unknown` before the pin, `trusted` after, `mismatch` for a different key
  or type — and the host:port token scoping.

The desktop-only fleet layers (flaky, instance) are deliberately absent:
forced-disconnect reconnect and the manual demo instance are client
features, and core's transport is a one-method interface.

## Embed check

`npm run embed` — builds the single-file IIFE and verifies the SAME contract
assertions in Node's `vm` AND a real QuickJS. This is the Android surface
exercised as code, including `HostCliCore`'s async exec bridge success and
typed failure paths, attach builder, and pure parsers for sessions,
workspaces, engines, and profiles. See README ("The Android path").

## The gate

`npm test` = unit + integration (Docker up, images built). CI runs the fast
gate (build + unit + embed) on every push and the Docker-backed integration
job next to it; see `.github/workflows/ci.yml`.
