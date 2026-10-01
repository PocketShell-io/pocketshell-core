# Shared Vue UI source

This private source package lives in `@pocketshell/core`'s repository and is
shared by PocketShell Desktop, the web app, and the JS-first Android app.
Consumers pin a pocketshell-core commit (or check out the `pocketshell-core`
sibling the way the `file:../pocketshell-core` dependency already does) and
import these files directly; this package is not published to npm.

## Browser entry points

- `src/index.ts` exports the theme and font policy, `AppIcon`, and
  `ComposerControls`.
- `src/styles.css` loads Inter Variable, the shared token defaults and common
  CSS primitives. Import it once in the browser app.
- `src/browser.ts` combines both entry points for an isolated Vite build.

## Consumer dependencies

The source package expects these modules in the consuming browser toolchain:

- `vue` 3.5 or compatible, as the runtime for the exported Vue components.
- `@xterm/xterm` 6 or compatible for the `ITheme` type used by the theme
  records; this is a type-only import and is absent from the runtime bundle.
- `@fontsource-variable/inter` 5 or compatible, resolved by `styles.css` and
  bundled locally so rendering does not depend on a network font fetch.

The consumer's bundler must process Vue single-file components and CSS imports.
The desktop app currently tests against Vue 3.5.13, `@xterm/xterm` 6.0.0,
`@fontsource-variable/inter` 5.3.0, and Vite 6. Android can use its existing
compatible versions or pin these tested versions in its rewrite.

The desktop app maps `@ui` to `../pocketshell-core/packages/ui/src` (the same
sibling checkout the `@pocketshell/core` dependency uses); the web app maps the
same alias in its Vite config. Android can map `@pocketshell/ui` to a pinned
checkout's `packages/ui/src` and import `styles.css` alongside the entry.
Components exchange state only through props and emitted events. Keep Electron
IPC, Pinia stores, SSH and host I/O in the application.

The mono font policy accepts a consumer fallback stack. Desktop uses its
Consolas default; Android should provide the bundled JetBrains Mono stack
specified by the rewrite plan.

## The shared app and its extension points

Every client mounts `src/app/AppRoot.vue` (theme and typography watchers,
the diagnostics and update strips, the router outlet) and builds its router
from `createAppRoutes(extra)` in `src/app/routes.ts`, adding only its own
routes and its own history. Nothing under `src/app` branches on the
platform; a client's own features plug in at startup:

- API groups a platform provides or omits (`update`, `editors`, ...): a
  capability exists when its group does.
- UI slots, `provideExtensions()` in `src/app/extensions.ts`:
  `terminal.dock`, `terminal.inputAdapter`, `composer.inputSources`,
  `composer.accessory`, `settings.sections` (platform settings groups, which
  Settings renders after the shared ones). An empty slot renders no DOM.
- `app.dismissLayers`: open overlays register a close handler; the
  platform's dismiss gesture calls `dismissTopLayer()`.
- The inset contract, `--ps-inset-top/bottom/left/right/keyboard`
  (`src/app/insets.ts`, `writeAppInsets`). Desktop and web leave them at 0.

Build, typecheck and test this source standalone with `npm run build`,
`npm run typecheck` and `npm run test` in this directory (core's CI gates all
three), or from the desktop repo with `npm run build:ui` and
`npm run typecheck:ui`. `npm run test` runs every `tests/**/*.test.ts` under
the one shared-UI setup (`vitest.config.ts`): stores, pure modules and
components. `.vue` files compile through the Vue plugin and can be mounted with
`@vue/test-utils`; the default environment is `node`, and a spec that needs a
DOM starts with `// @vitest-environment jsdom` (desktop's convention).

Host list: a platform that reads its hosts (desktop `~/.ssh/config`, the web's
synced account) implements `ssh.listConfigHosts`. A platform that owns its
host list (Android) additionally provides the optional `hosts.store` capability,
a one-to-one bridge onto core's `SavedHostStore`; `stores/hosts.ts` then
mirrors that store's snapshots and routes create/edit/delete/reorder and the
default host through it. Identity-bearing decisions compare
`hostEntryId(host)` — the saved host's stable `id`, or the `Host` alias.

Pinia store ids: every client mounts this UI into an app with its own stores,
and Pinia merges two stores that share an id. Shared store ids must not reuse a
client's ids; `tests/storeIds.test.ts` lists the clients' ids and enforces it.
