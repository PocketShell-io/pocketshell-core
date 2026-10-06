/**
 * The user-bin directories the helper is allowed to live in.
 *
 * This exists as one constant because it is consumed from both sides of the
 * process boundary and the two uses have to agree:
 *
 *   - `src/main/helper/bootstrap.ts` prepends it before `command -v` when it
 *     probes a host over an SSH *exec* channel, which sshd runs under a
 *     non-login shell whose PATH is often just `/usr/bin:/bin`;
 *   - `src/shared/attachCommand.ts` prepends it inside the session PTY before
 *     invoking the helper.
 *
 * If those two lists ever drift, bootstrap reports a helper the attach command
 * then cannot find — the app says the host is fine and the join fails anyway,
 * which is the exact shape of the bug this whole module exists to prevent.
 *
 * The list matches the Android app's `pathAwareCommand` wrapper.
 *
 * The last two dirs are where a `pocketshell` install puts its BUNDLED
 * aplexer. Since helper 0.5.x, `aplexer` is a pinned hard dependency of the
 * pocketshell CLI: `uv tool install pocketshell` drops the `a` and `aplexer`
 * console-scripts into the tool venv's own bin dir, and the helper resolves
 * that copy for its own calls (its PATH lookup is hard-cut by design). pipx
 * keeps the same layout one level over. The helper's own `uv`/`pipx` symlink
 * into `~/.local/bin` exposes only `pocketshell`, so without these dirs the
 * app's `command -v a` probe answers no on exactly the hosts that followed
 * the one documented install step — and every aplexer path (list, create,
 * join, stop, rename) dies behind a green readiness chip. `a` as a separate
 * install is legacy: the dirs come after the standard user bins so a
 * deliberately installed standalone `a` still wins, and nothing a venv ships
 * (`a`, `aplexer`, `pocketshell`, `quse`) collides with a system binary the
 * app invokes.
 */
export const USER_BIN_DIRS = [
  '$HOME/.local/bin',
  '$HOME/bin',
  '$HOME/.cargo/bin',
  '$HOME/.local/share/uv/tools/pocketshell/bin',
  '$HOME/.local/pipx/venvs/pocketshell/bin',
] as const;

/**
 * The user-bin dirs as a PATH prefix, joined with `:` — no trailing `:$PATH`,
 * because the two call sites splice it into different shapes.
 */
export const USER_BIN_PATH = USER_BIN_DIRS.join(':');
