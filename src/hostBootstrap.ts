/**
 * The host bootstrap probe: which PocketShell tools a connected host has.
 *
 * One platform-neutral implementation over an exec effect, so the desktop
 * main process, the web transport and the Android adapter all run the same
 * probe sequence and parse it with the same parsers (#2936). Lifted from the
 * web client's `platform/hostHelper.ts`, which mirrored the desktop's
 * `main/helper/bootstrap.ts` call for call.
 */
import type { BootstrapResult, ExecResult, HostPlatform, ToolState } from './types';
import { pathAwareCommand } from './aplexerCommands';
import { parseCommandV } from './hostProbeParsers';
import { detectHostPlatform } from './hostPlatform';

export type BootstrapExec = (command: string) => Promise<ExecResult>;

/** Options for {@link runHostBootstrap}. */
export interface HostBootstrapOptions {
  /**
   * The host's platform when the caller already knows it (a per-connection
   * cache, a platform that detected it earlier). When omitted the probe runs
   * its own detection — one extra exec — so every caller can pass the result
   * through unchanged.
   */
  platform?: HostPlatform;
}

/** Probe one tool: `command -v <binary>` under the path-aware shell. */
async function probeTool(exec: BootstrapExec, binary: string): Promise<ToolState> {
  const res = await exec(pathAwareCommand(`command -v ${binary}`));
  const path = parseCommandV(res.stdout, res.exitCode);
  if (!path) return { installed: false, path: null, version: null };
  const versionRes = await exec(pathAwareCommand(`${binary} --version`));
  const version = versionRes.exitCode === 0 ? versionRes.stdout.trim().split(/\r?\n/)[0] : null;
  return { installed: true, path, version: version ?? null };
}

/** Detect the python installer: `command -v uv` then `command -v pipx`. */
async function detectInstaller(exec: BootstrapExec): Promise<'uv' | 'pipx' | null> {
  for (const binary of ['uv', 'pipx'] as const) {
    const res = await exec(pathAwareCommand(`command -v ${binary}`));
    if (parseCommandV(res.stdout, res.exitCode)) return binary;
  }
  return null;
}

/** Wrap a `systemctl --user` command with the env vars systemd needs over SSH. */
function systemdUserCommand(command: string): string {
  const env =
    `XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)} ` +
    `DBUS_SESSION_BUS_ADDRESS=unix:path=\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus`;
  return pathAwareCommand(`export ${env}; ${command}`);
}

const NOT_INSTALLED: ToolState = { installed: false, path: null, version: null };

/**
 * The probe itself: the `pocketshell` helper, the tmux join binary
 * (`tmuxctl`), raw tmux, and `a` (aplexer), plus the installer and the
 * daemon state. Probes run in parallel; the exec effect decides how a
 * transport failure is reported.
 *
 * On a Windows host the helper, `tmuxctl` and tmux cannot exist — OpenSSH for
 * Windows has neither, and no amount of probing installs them. Probing anyway
 * costs five round trips to report exactly what is already known, so on
 * `platform: 'windows'` those three are answered WITHOUT an exec and only
 * `a` (aplexer — the session manager Windows hosts are expected to gain) and
 * the installer are probed. The daemon check stays gated on the helper and
 * therefore skips itself.
 */
export async function runHostBootstrap(
  exec: BootstrapExec,
  options: HostBootstrapOptions = {},
): Promise<BootstrapResult> {
  const platform = options.platform ?? (await detectHostPlatform(exec));
  const posixOnly = platform === 'windows';
  const [pocketshell, tmuxctl, tmux, aplexer, installer] = await Promise.all([
    posixOnly ? Promise.resolve(NOT_INSTALLED) : probeTool(exec, 'pocketshell'),
    posixOnly ? Promise.resolve(NOT_INSTALLED) : probeTool(exec, 'tmuxctl'),
    posixOnly ? Promise.resolve(NOT_INSTALLED) : probeTool(exec, 'tmux'),
    probeTool(exec, 'a'),
    detectInstaller(exec),
  ]);

  let daemonRunning: boolean | null = null;
  let daemonEnabled: boolean | null = null;
  if (pocketshell.installed) {
    const systemctlRes = await exec(pathAwareCommand('command -v systemctl'));
    if (parseCommandV(systemctlRes.stdout, systemctlRes.exitCode)) {
      const active = await exec(systemdUserCommand('systemctl --user is-active pocketshell-jobs.service'));
      daemonRunning = active.exitCode === 0;
      const enabled = await exec(systemdUserCommand('systemctl --user is-enabled pocketshell-jobs.service'));
      daemonEnabled = enabled.exitCode === 0;
    }
  }

  return { platform, pocketshell, tmuxctl, tmux, aplexer, installer, daemonRunning, daemonEnabled };
}

/**
 * The tools a host must have for PocketShell to work here — the names the
 * missing-tools strip lists.
 *
 * One name: `pocketshell`. Since helper 0.5.x the CLI carries aplexer as a
 * pinned hard dependency and resolves its bundled `a` itself (the app finds
 * the same copy through USER_BIN_DIRS), so every session path — list, create,
 * join, stop, rename — rides the one binary. `tmuxctl` and `tmux` are not
 * part of that story: the 0.5.x `sessions` group is aplexer-only, and the
 * raw-tmux arms beneath it are legacy fallbacks for hosts that predate the
 * bundled layout, not requirements. Demanding them here told every current
 * host — pocketshell installed, nothing else — that it was broken.
 *
 * A Windows host stays the exception in its own right: the helper cannot
 * exist there at all, and the strip would name the same absent binary for
 * the life of the connection. That is not information, it is noise — the
 * platform answer suppresses the whole list.
 */
export function missingHostTools(bootstrap: BootstrapResult | null): string[] {
  if (!bootstrap) return [];
  if (bootstrap.platform === 'windows') return [];
  return bootstrap.pocketshell.installed ? [] : ['pocketshell'];
}

/** "pocketshell"; "pocketshell and tmuxctl" when the list grows back. */
export function missingHostToolsText(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
