/**
 * Agent picker catalog and the `pocketshell agent …` launch-line builder.
 *
 * Online engine IDs come from the host's `a engines --json` result through the
 * platform API. The static names in this module are only an offline fallback.
 * Launch flag spellings still follow the captured `pocketshell agent` help
 * fixtures below; unknown engines receive only the required `--dir` argument.
 */
import { shellQuote, shellQuoteRemotePath } from './shellQuote.js';

/**
 * A small offline fallback for hosts whose `a engines --json` query cannot be
 * completed. The online list is supplied to {@link launchableKindsFor}; it is
 * the authority whenever it is available.
 */
export type LaunchableKind = string;

/**
 * Display names for the picker. Title-case; the phone uses lowercase CLI names.
 * Claude is the one word, not "Claude Code": the picker renders each name on
 * one segment, and the two-word form is the only one that wraps to a second
 * line at the dialog's width.
 */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  antigravity: 'Antigravity',
};

/** Engine IDs used only when the live aplexer catalog cannot be read. */
export const OFFLINE_LAUNCHABLE_KINDS = Object.keys(KIND_LABELS);

/**
 * Current launchable IDs from `a engines --json`; null means offline/failure
 * and uses the small static fallback. The aplexer catalog also lists `shell`,
 * which is handled by the separate Shell choice in the launch dialog.
 */
export function launchableKindsFor(engineIds: readonly string[] | null | undefined): LaunchableKind[] {
  if (!Array.isArray(engineIds)) return [...OFFLINE_LAUNCHABLE_KINDS];
  const seen = new Set<string>();
  const kinds: string[] = [];
  for (const raw of engineIds) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!isLaunchableKind(id) || seen.has(id)) continue;
    seen.add(id);
    kinds.push(id);
  }
  return kinds;
}

/**
 * A human label for an engine ID. `a engines --json` owns the catalog and
 * returns IDs only, so known names keep their familiar spelling and custom
 * names get a readable title-case fallback.
 */
export function kindLabel(kind: LaunchableKind): string {
  const known = Object.prototype.hasOwnProperty.call(KIND_LABELS, kind) ? KIND_LABELS[kind] : undefined;
  if (known) return known;
  return kind
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Whether [kind] is a non-empty engine ID rather than a session state. */
export function isLaunchableKind(kind: unknown): kind is LaunchableKind {
  return (
    typeof kind === 'string' &&
    kind.trim() !== '' &&
    !['shell', 'probing', 'exited', 'unknown'].includes(kind.toLowerCase())
  );
}

/** Whether this kind has a captured and supported permissions option. */
export function supportsSkipPermissions(kind: LaunchableKind): boolean {
  return kind === 'claude' || kind === 'codex' || kind === 'antigravity';
}

/**
 * Whether a profile can be chosen for the kind. Only Claude and Codex have
 * profile rows in the helper contract; custom engines default to no profile.
 */
export function supportsProfiles(kind: LaunchableKind): boolean {
  return kind === 'claude' || kind === 'codex';
}

/**
 * Catalog and independent PATH probe for one host. `engineIds` is the
 * available-engine list from `a engines --json`, or null when the query could
 * not be completed. An empty list is a successful answer with no launchable
 * agents. `binaries` remains a separate readiness check for the `pocketshell`
 * launcher and, when the engine catalog is unavailable, the offline fallback.
 */
export interface HostAgentSupport {
  engineIds: readonly string[] | null;
  /**
   * The names found on the host's PATH — `pocketshell` and the fallback engine
   * CLIs — answered by one `command -v` batch, or null when the probe has not
   * run or failed. A live `a engines` catalog already carries engine
   * availability, so this probe only checks that the launcher itself is
   * present in that case.
   */
  binaries?: readonly string[] | null;
  /** True while the engine query is in flight. */
  probing?: boolean;
}

/**
 * Why this host cannot start [kind] right now, or null when it can.
 *
 * The online engine catalog is authoritative. When it is unavailable, the
 * picker uses its offline fallback and checks the matching executable names.
 * The independent `pocketshell` check applies in both cases.
 */
export function kindUnavailableReason(
  kind: LaunchableKind,
  support: HostAgentSupport,
): string | null {
  const label = kindLabel(kind);
  const listed = Array.isArray(support.engineIds) ? support.engineIds : null;
  if (listed !== null && !listed.includes(kind)) {
    return `This host does not report an available ${label} engine in \`a engines\`.`;
  }
  if (listed === null && support.probing) {
    return `Checking whether this host has an available ${label} engine…`;
  }
  // A live catalog reports engine availability independently of executable
  // names, which also supports custom engine IDs. Keep the `pocketshell` PATH
  // check in all cases and use per-engine command names only for offline
  // fallback IDs.
  const found = Array.isArray(support.binaries) ? support.binaries : null;
  if (found !== null) {
    if (!found.includes('pocketshell')) {
      return (
        'This host has no `pocketshell` on its PATH — install the pocketshell ' +
        'helper first, then reconnect and try again.'
      );
    }
    if (listed === null && !found.includes(kind)) {
      return (
        `This host has no \`${kind}\` on its PATH — install the ${label} CLI ` +
        'first, then try again.'
      );
    }
  }
  return null;
}

/**
 * The names on the host's PATH, from the one `command -v` batch the desktop
 * runs (`for n in pocketshell <kinds>; do command -v ...; done`).
 *
 * The output is the found names, one per line — the loop echoes the NAME, not
 * the resolved path, so no basename guessing. Only the launcher and the
 * offline fallback names are accepted here; online catalog IDs use the
 * catalog's own availability field instead.
 */
export function parseAgentBinaries(stdout: string): string[] {
  const known = new Set<string>(['pocketshell', ...OFFLINE_LAUNCHABLE_KINDS]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => known.has(line));
}

/** One row of `pocketshell profiles list --json`'s `{"profiles": [...]}`. */
export interface AgentProfile {
  name: string;
  engine: string;
  /** `null` for the engine's built-in default location. */
  configDir: string | null;
  /** The engine's default profile; the picker pre-selects it. */
  default: boolean;
}

/**
 * Parse the `{"profiles": [...]}` envelope 0.4.44 emits.
 *
 * The rows arrive over IPC as `unknown[]` ({@link
 * PocketshellClient.listProfiles} unwraps the envelope but does not type the
 * rows), so this is where they become data. A row with no usable `name` or
 * `engine` is DROPPED rather than defaulted: a nameless profile cannot be
 * passed to `--profile`, and inventing a name for it would produce a launch
 * line the host rejects with `unknown claude profile`.
 */
export function parseProfileRows(rows: readonly unknown[]): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    const engine = typeof r['engine'] === 'string' ? r['engine'].trim() : '';
    if (name === '' || engine === '') continue;
    const rawDir = r['config_dir'];
    out.push({
      name,
      engine,
      configDir: typeof rawDir === 'string' && rawDir.trim() !== '' ? rawDir.trim() : null,
      default: r['default'] === true,
    });
  }
  return out;
}

/** The profiles that apply to one kind, host order preserved (default first). */
export function profilesFor(
  kind: LaunchableKind,
  profiles: readonly AgentProfile[],
): AgentProfile[] {
  if (!supportsProfiles(kind)) return [];
  return profiles.filter((p) => p.engine === kind);
}

/**
 * The name to put in `--profile` for a picked profile, or null for none.
 *
 * Null for the engine's DEFAULT profile, matching the phone
 * (`launchCommand`'s `.takeUnless { it.default }`): the default is what the
 * agent uses when `--profile` is absent, so naming it adds a flag that can
 * fail — `unknown claude profile` if the host renames it — in exchange for no
 * change in behaviour. Null too for a remembered name the host no longer
 * lists, which is how a profile deleted on the host stops haunting the
 * dialog.
 */
export function profileFlagName(
  picked: string | null,
  available: readonly AgentProfile[],
): string | null {
  if (!picked) return null;
  const match = available.find((p) => p.name === picked);
  if (!match || match.default) return null;
  return match.name;
}

/** Everything the picker collects. */
export interface LaunchChoice {
  kind: LaunchableKind;
  /** Folder the agent starts in. May be a literal `~/…`. */
  dir: string;
  /** Per-action approval prompts disabled. Host default is `true`. */
  skipPermissions: boolean;
  /** Profile NAME as the host reports it, or null for the engine default. */
  profile: string | null;
}

/**
 * The literal line typed into the session's PTY (no trailing `\r`).
 *
 * Quoting, which is the whole reason this is not a template string at the
 * call site:
 *
 * - **`--dir` uses {@link shellQuoteRemotePath}**, not a plain quote. This is
 *   the one deliberate divergence from the phone, which single-quotes the
 *   directory flat. A desktop folder key can be a literal, unexpanded `~/git/x`
 *   — tmux reports cwds that way and `stripTilde` in renderer/remotePaths.ts
 *   exists because of it — and `'~/git/x'` inside single quotes is four literal
 *   characters the shell will not expand, so the helper would look for a
 *   directory named `~`. `shellQuoteRemotePath` emits `$HOME/'git/x'`: the
 *   prefix expands, the rest is inert data, and a folder called
 *   `wei'rd $(touch /tmp/PWNED)` still travels as text.
 * - **`--profile` uses a plain {@link shellQuote}.** A profile name is data,
 *   never a path — the host's own discovery produces names like
 *   `Claude (Z.AI)`, with a space and parentheses, which unquoted would split
 *   into three words and fail as `unknown claude profile: 'Claude'`.
 *
 * Flags are emitted only when they carry information (see the header): the
 * host defaults skip-permissions ON, so only the negative is spoken, and
 * never for opencode where it is a no-op.
 *
 * The engine's DEFAULT profile is passed as `profile: null` by the caller,
 * not stripped here — see {@link profileFlagName}. Naming it and omitting it
 * are the same launch, and this function stays a dumb renderer of the choice
 * it is handed so that what you read here is what the host receives.
 */
export function buildLaunchCommand(choice: LaunchChoice): string {
  // Keep ordinary engine IDs readable in the terminal preview. Custom IDs can
  // contain spaces or shell syntax, so quote those as one argument.
  const kind = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(choice.kind)
    ? choice.kind
    : shellQuote(choice.kind);
  const parts = ['pocketshell', 'agent', kind, '--dir', shellQuoteRemotePath(choice.dir)];
  if (supportsSkipPermissions(choice.kind) && !choice.skipPermissions) {
    parts.push('--no-skip-permissions');
  }
  const profile = choice.profile?.trim();
  if (supportsProfiles(choice.kind) && profile) {
    parts.push('--profile', shellQuote(profile));
  }
  return parts.join(' ');
}

/**
 * Why {@link buildLaunchCommand} would produce a line the host rejects, or
 * null when it would not.
 *
 * Called BEFORE the session is created, which is the point: the old flow
 * created a session and only then discovered the command was malformed,
 * leaving a shell plus a usage message in the terminal. A launch that cannot
 * work should cost the user nothing.
 *
 * `support` is the host capability probe, and it is OPTIONAL on purpose. The
 * picker (`LaunchSessionDialog`) passes it, because the picker is the one
 * place a user chooses a kind and therefore the one place the choice can still
 * be steered. The callers downstream of it — `FolderWorkspaceView.createSession`
 * and `NewSessionDialog.commit` — re-run this check on a choice the picker has
 * already vetted, and they run it on a code path where the answer can only be
 * "too late". Omitting the argument there means the host check is skipped
 * rather than re-decided from a store those components would have to grow a
 * dependency on. The shape check — is this a kind at all, is there a
 * directory — still runs for everyone, which is what those callers are
 * actually guarding against.
 */
export function launchBlocker(
  choice: Partial<LaunchChoice>,
  support?: HostAgentSupport,
): string | null {
  if (!choice.kind || !isLaunchableKind(choice.kind)) {
    return 'Pick an agent to launch.';
  }
  if (support) {
    const unavailable = kindUnavailableReason(choice.kind, support);
    if (unavailable) return unavailable;
  }
  // `--dir` is required and the helper resolves it host-side; a blank one
  // would make `shellQuoteRemotePath` fall back to `$HOME`, silently starting
  // the agent in the home directory instead of the folder the user is in.
  if (!choice.dir || choice.dir.trim() === '') {
    return 'This folder has no known directory on the host, so an agent cannot be launched in it.';
  }
  return null;
}
