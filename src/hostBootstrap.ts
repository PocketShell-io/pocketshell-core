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

const NOT_INSTALLED: ToolState = { installed: false, path: null, version: null };

/** Tools whose path AND `--version` the probe reports. */
const VERSIONED_TOOLS = ['pocketshell', 'tmuxctl', 'tmux', 'a'] as const;
/** Python installers, in preference order. */
const INSTALLERS = ['uv', 'pipx'] as const;

const END_MARKER = 'PS_PROBE_END';

/**
 * The whole probe as ONE shell script (one SSH exec instead of ~13), printing
 * `key=value` lines. Same semantics as the per-tool execs it replaced: path
 * from `command -v`, version only when `--version` exits 0 (first line), the
 * installer is the first of uv/pipx on PATH, and the daemon is probed only
 * when the helper AND systemctl exist.
 */
function probeScript(tools: readonly string[], withDaemon: boolean): string {
  const parts: string[] = [];
  for (const tool of tools) {
    parts.push(
      `p=$(command -v ${tool}) && [ -n "$p" ] && { echo "path.${tool}=$p"; ` +
        `v=$(${tool} --version 2>/dev/null) && echo "version.${tool}=$(printf '%s\\n' "$v" | sed -n 1p)"; }`,
    );
  }
  parts.push(`ins=; for i in ${INSTALLERS.join(' ')}; do command -v $i >/dev/null 2>&1 && { ins=$i; break; }; done; echo "installer=$ins"`);
  if (withDaemon) {
    const unit = 'pocketshell-jobs.service';
    parts.push(
      `p=$(command -v pocketshell) && [ -n "$p" ] && command -v systemctl >/dev/null 2>&1 && { ` +
        'export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}; ' +
        'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; ' +
        `systemctl --user is-active ${unit} >/dev/null 2>&1; echo "daemon.running=$?"; ` +
        `systemctl --user is-enabled ${unit} >/dev/null 2>&1; echo "daemon.enabled=$?"; }`,
    );
  }
  parts.push(`echo ${END_MARKER}`);
  return parts.join('; ');
}

function toolFrom(values: Map<string, string>, tool: string): ToolState {
  const path = values.get(`path.${tool}`) ?? '';
  if (!path) return { installed: false, path: null, version: null };
  const version = values.get(`version.${tool}`)?.trim();
  return { installed: true, path, version: version ? version : null };
}

/**
 * The probe itself: the `pocketshell` helper, the tmux join binary
 * (`tmuxctl`), raw tmux, and `a` (aplexer), plus the installer and the
 * daemon state — all in a single exec; the exec effect decides how a
 * transport failure is reported.
 *
 * On a Windows host the helper, `tmuxctl` and tmux cannot exist — OpenSSH for
 * Windows has neither, and no amount of probing installs them. So on
 * `platform: 'windows'` those three are answered WITHOUT being probed and only
 * `a` (aplexer — the session manager Windows hosts are expected to gain) and
 * the installer are. The daemon check stays gated on the helper and
 * therefore skips itself.
 */
export async function runHostBootstrap(
  exec: BootstrapExec,
  options: HostBootstrapOptions = {},
): Promise<BootstrapResult> {
  const platform = options.platform ?? (await detectHostPlatform(exec));
  const posixOnly = platform === 'windows';
  const tools = posixOnly ? ['a'] : [...VERSIONED_TOOLS];
  const res = await exec(pathAwareCommand(probeScript(tools, !posixOnly)));
  const values = new Map<string, string>();
  let complete = false;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line === END_MARKER) complete = true;
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  if (!complete) throw new Error(`host probe failed (exit ${res.exitCode}): ${res.stderr.trim()}`);
  const installerName = values.get('installer');
  const installer = installerName === 'uv' || installerName === 'pipx' ? installerName : null;
  const pocketshell = posixOnly ? NOT_INSTALLED : toolFrom(values, 'pocketshell');
  const daemonRunning = values.has('daemon.running') ? values.get('daemon.running') === '0' : null;
  const daemonEnabled = values.has('daemon.enabled') ? values.get('daemon.enabled') === '0' : null;
  return {
    platform,
    pocketshell,
    tmuxctl: posixOnly ? NOT_INSTALLED : toolFrom(values, 'tmuxctl'),
    tmux: posixOnly ? NOT_INSTALLED : toolFrom(values, 'tmux'),
    aplexer: toolFrom(values, 'a'),
    installer,
    daemonRunning,
    daemonEnabled,
  };
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
