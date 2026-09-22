# @pocketshell/core

PocketShell's contract layer as ONE TypeScript implementation, shared by every
client: the desktop (Electron), the web SPA, and — through an embedded JS
engine — the Android app.

The package exists to kill the copy problem: the web app used to hold 19
verbatim copies of the desktop's `src/shared/` modules, refreshed by a sync
script after every change. Now the code lives here once, and the clients
depend on it. A contract change is one commit in this repo.

## What's inside

Pure TypeScript only — no Node APIs, no DOM, no I/O. The platform surface is
exactly `setTimeout`, `clearTimeout`, `atob`, and `TextDecoder`
(`types/globals.d.ts`), all provided by browsers, Electron, Node 16+, and the
shim set in `embed/host-shims.js`.

| Module | Contract |
| --- | --- |
| `types` | hosts, sessions, forward specs — the shared vocabulary |
| `sync`, `syncConfig`, `syncMerge` | the settings-sync payload: assemble, serialize, parse, merge |
| `sshConfigCore` | `~/.ssh/config` directive parsing and host folding |
| `knownHostsCore` | host-key tokens, verdicts, blob decode |
| `osc52` | OSC 52 clipboard decode |
| `aplexer`, `aplexerCommands`, `aplexerParsers` | the session manager's types, CLI commands, and output parsers |
| `aplexerClientCore` | the whole aplexer client brain over a one-method `exec` transport |
| `agentCommands`, `agentLaunch` | what `pocketshell agent …` launches per agent, and the launch line builder |
| `composerSend` | send pipeline: bracketed paste, three-write delivery, submit timing |
| `sftpCore` | SFTP listing/entry rules both clients' Files panes share |
| `shellQuote`, `userBinPath`, `net`, `byteSize` | quoting, `~/.local/bin`, loopback/port constants, byte formatting |

`AplexerCore` shows the pattern the I/O-ish modules follow: the core holds
every contract and decision, and the client injects a one-method transport
(desktop: SshService by connection id; web: the workspace connection; a
future Android client: its SSH transport).

## Clients

- **pocketshell-desktop** — `devDependencies: "@pocketshell/core":
  "file:../pocketshell-core"`. electron-vite bundles it into main, preload,
  and renderer (devDependencies are build inputs; only `dependencies` are
  externalized — see that repo's `packagedDependencies.test.ts`).
- **pocketshell-web** — same `file:` dependency; Vite bundles it into the SPA.
  The 19 vendored copies and `scripts/sync-shared.sh` are gone.
- **Android** — see below.

Both JS clients keep their own vitest suites running against the package, so
the same sources are exercised from both shells. When this package is
published to npm, the `file:` specs become plain versions.

## Changing the contract

1. Edit here. Keep modules pure; extend `types/globals.d.ts` only for APIs
   every client genuinely provides.
2. `npm run test:unit` (the ported contract suites), `npm run test:integration`
   (core's clients against the Docker fleet — see `docs/TESTING.md`), and
   `npm run embed` (dual-engine verification) must pass.
3. `npm run build` — the apps resolve into `dist/` through the `file:` link,
   so a rebuild here is propagation; no republish, no reinstall.
4. Commit here first, then bump/pin the apps as they adopt it.

## The Android path

The app is Kotlin, but the contracts above are already JS and the desktop +
web prove a client only needs them plus a thin shell. The prototype path:
bundle the whole core into one file and evaluate it in an embedded JS engine
(QuickJS, via quickjs-android or equivalent).

```bash
npm run embed
```

- `embed/pocketshell-core.js` — the entire core as one IIFE installing a
  single `PocketShellCore` global (~44 KB unminified).
- `embed/host-shims.js` — the host surface an engine must provide, with
  working fallbacks (`atob`, a UTF-8 `TextDecoder`; timers fail loudly unless
  the embedder wires real ones).

`scripts/verify-embed.mjs` runs the SAME contract assertions against the SAME
bundle in TWO engines — Node's vm, and a real QuickJS (quickjs-emscripten).
The QuickJS pass is the Android integration surface exercised as code, not a
claim. On the device, the Kotlin side is the same shape:

```kotlin
// build once, ship as an asset; evaluate with your QuickJS binding of choice
quickjs.evaluate(asset("host-shims.js"))
quickjs.evaluate(asset("pocketshell-core.js"))
val quoted = quickjs.evaluate(
    "PocketShellCore.shellQuote('some path with spaces')")
// async contracts (AplexerCore) go over a small JS<->Kotlin bridge object
// that answers the injected transport's exec() with a real SSH exec.
```

What is verified today: the bundle runs and answers contract assertions in
QuickJS, and the desktop + web suites pin the same sources. What is next:
a Kotlin module that loads the bundle on-device and bridges `AplexerCore`'s
transport to sshj, then parsers/usage move over module by module — each one
deleting its Kotlin twin in the app's `shared/core-*`.

## Development

```bash
npm install
npm run build-docker  # once: the test fleet (same images as desktop + Android)
npm test              # unit contract suites + integration tier (Docker)
npm run test:unit     # unit tier only — no Docker needed
npm run build         # dist/esm + dist/cjs + types
npm run embed         # esbuild bundle + dual-engine verification
```

## Release flow

Publishing is tag-triggered, the same shape as the CLI's PyPI flow: a `vX.Y.Z`
tag makes CI build the package, verify the tag equals `version` in
package.json, and publish the tarball to npm with the `NPM_TOKEN` repo secret.
The tag is the release declaration — there is no separate release step:

```bash
npm version patch        # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

If the publish job fails after the tag is pushed, fix the cause and re-run
that job from the Actions tab — the re-run keeps the tag ref, so the tag does
not need to move. Anything else (dispatches, plain pushes) runs the build job
only and never publishes.

History: every module here was copied verbatim from
pocketshell-desktop's `src/shared/` when the package was created (they were
the modules pocketshell-web vendored); `git log` in that repo holds their
earlier history.
