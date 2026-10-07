/**
 * The interactive shell of a LOCAL (self) terminal — the one setting that
 * changes what a bare terminal tab on your own machine runs.
 *
 * Scope is deliberate: only the BARE terminal. Two other shells are involved
 * on a local host and neither is this one — the exec transport stays a POSIX
 * shell (the app's command lines are `/bin/sh -lc`-wrapped), and the shell
 * INSIDE an aplexer session is the session worker's own (`APLEXER_SHELL`,
 * aplexer's config). This setting is what answers "when I open a plain
 * terminal on myself, what am I typing at".
 *
 * Renderer-safe: ids and pure string work here; the SPAWN resolution is pure
 * too, taking the Windows layout root (`SystemRoot`) as an argument so the
 * main process passes `process.env.SystemRoot` and tests pass a fixture.
 */

/** The shell ids the setting accepts. Empty string is "auto": Git Bash. */
export type LocalShellChoice = '' | 'powershell' | 'pwsh' | 'cmd';

export const LOCAL_SHELL_DEFAULT: LocalShellChoice = '';

/** True when [raw] is a choice the setting accepts. */
export function isLocalShellChoice(raw: unknown): raw is LocalShellChoice {
  return raw === '' || raw === 'powershell' || raw === 'pwsh' || raw === 'cmd';
}

/** Tolerant parse for the settings store: unrecognised values read as default. */
export function parseLocalShell(raw: unknown): LocalShellChoice | undefined {
  return isLocalShellChoice(raw) ? raw : undefined;
}

/** One picker row: the stored id and its label. */
export interface LocalShellOption {
  id: LocalShellChoice;
  label: string;
  /** The hint line under the label, when the shell needs introducing. */
  detail?: string;
}

/** The picker's rows, in the order offered. Auto first — it is the default. */
export const LOCAL_SHELL_OPTIONS: readonly LocalShellOption[] = [
  {
    id: '',
    label: 'Auto (Git Bash)',
    detail: 'The POSIX shell the app drives the machine with',
  },
  { id: 'powershell', label: 'Windows PowerShell', detail: 'Ships with Windows' },
  { id: 'pwsh', label: 'PowerShell 7', detail: 'pwsh, if installed' },
  { id: 'cmd', label: 'Command Prompt' },
];

/** The spawn a choice resolves to. */
export interface LocalShellSpawn {
  file: string;
  args: string[];
}

/**
 * Resolve a choice to the process to spawn, or null when the choice is the
 * default ("auto") — the caller then uses its own bash discovery.
 *
 * `-NoLogo` keeps the banner out of the first paint; a terminal whose first
 * screen is the prompt is the point of a terminal. `powershell` and `cmd`
 * resolve against the Windows layout (`SystemRoot`), `pwsh` against PATH —
 * PowerShell 7 installs per-user and is not under the Windows directory.
 */
export function resolveLocalShell(
  choice: string,
  opts: { systemRoot?: string } = {},
): LocalShellSpawn | null {
  if (!isLocalShellChoice(choice) || choice === '') return null;
  const systemRoot = opts.systemRoot ?? 'C:\\Windows';
  switch (choice) {
    case 'powershell':
      return {
        file: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        args: ['-NoLogo'],
      };
    case 'pwsh':
      return { file: 'pwsh.exe', args: ['-NoLogo'] };
    case 'cmd':
      return { file: `${systemRoot}\\System32\\cmd.exe`, args: [] };
  }
}
