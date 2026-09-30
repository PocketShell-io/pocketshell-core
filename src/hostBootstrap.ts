/**
 * The host bootstrap probe: which PocketShell tools a connected host has.
 *
 * One platform-neutral implementation over an exec effect, so the desktop
 * main process, the web transport and the Android adapter all run the same
 * probe sequence and parse it with the same parsers (#2936). Lifted from the
 * web client's `platform/hostHelper.ts`, which mirrored the desktop's
 * `main/helper/bootstrap.ts` call for call.
 */
import type { BootstrapResult, ExecResult, ToolState } from './types';
import { pathAwareCommand } from './aplexerCommands';
import { parseCommandV } from './hostProbeParsers';

export type BootstrapExec = (command: string) => Promise<ExecResult>;

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

/**
 * The probe itself: the `pocketshell` helper, the tmux join binary
 * (`tmuxctl`), raw tmux, and `a` (aplexer), plus the installer and the
 * daemon state. Probes run in parallel; the exec effect decides how a
 * transport failure is reported.
 */
export async function runHostBootstrap(exec: BootstrapExec): Promise<BootstrapResult> {
  const [pocketshell, tmuxctl, tmux, aplexer, installer] = await Promise.all([
    probeTool(exec, 'pocketshell'),
    probeTool(exec, 'tmuxctl'),
    probeTool(exec, 'tmux'),
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

  return { pocketshell, tmuxctl, tmux, aplexer, installer, daemonRunning, daemonEnabled };
}
