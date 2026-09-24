/**
 * Pure parsing and classification for `pocketshell repos …` output.
 *
 * Lifted from the desktop main process (src/main/projects/repos.ts) so the
 * browser transport classifies a host's repos answer identically. The result
 * types (RepoEntry, ReposScopeResult, ReposListResult) live in transport.ts;
 * this module is only the functions over the helper's bytes.
 */

import type { RepoEntry, RepoLocal, RepoRemote, ReposScopeState } from './transport';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseLocal(value: unknown): RepoLocal | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const path = asString(record['path']);
  if (path === null) return null;
  return { path, head: asString(record['head']) };
}

function parseRemote(value: unknown): RepoRemote | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    defaultBranch: asString(record['default_branch']),
    htmlUrl: asString(record['html_url']),
    sshUrl: asString(record['ssh_url']),
    updatedAt: asString(record['updated_at']),
  };
}

/**
 * Parse a `repos list --json` payload.
 *
 * Tolerant by design — this decorates a picker, it does not gate it. Junk
 * around the array, a non-array payload, or a row with no usable name are all
 * dropped rather than thrown: an unparseable repos list must degrade to "no
 * repos offered", never break the session-creation flow it hangs off.
 */
export function parseReposJson(stdout: string): RepoEntry[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RepoEntry[] = [];
  for (const raw of parsed as unknown[]) {
    if (raw == null || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const local = parseLocal(record['local']);
    const owner = asString(record['owner']);
    // `name` is the helper's stable identity; fall back to the clone's
    // directory basename if a future payload ever omits it.
    const name =
      asString(record['name']) ??
      (local ? local.path.slice(local.path.lastIndexOf('/') + 1) : null);
    if (name === null) continue;
    out.push({
      name,
      owner,
      fullName: asString(record['full_name']) ?? (owner ? `${owner}/${name}` : null),
      local,
      remote: parseRemote(record['remote']),
    });
  }
  return out;
}

/** The identity two scopes are joined on. */
function repoKey(entry: RepoEntry): string {
  return entry.fullName ?? entry.name;
}

/**
 * Merge the local and remote scopes into one list.
 *
 * Local rows come first and win on identity, so a GitHub repo that is already
 * cloned renders as one row carrying BOTH blocks — the difference between an
 * "Open" affordance and a "Clone" one. Remote-only rows are appended in the
 * order `gh` returned them.
 */
export function mergeRepos(local: RepoEntry[], remote: RepoEntry[]): RepoEntry[] {
  const byKey = new Map<string, RepoEntry>();
  const order: string[] = [];
  for (const entry of local) {
    const key = repoKey(entry);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, entry);
  }
  for (const entry of remote) {
    const key = repoKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        owner: existing.owner ?? entry.owner,
        fullName: existing.fullName ?? entry.fullName,
        remote: existing.remote ?? entry.remote,
      });
    } else {
      order.push(key);
      byKey.set(key, entry);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Classify a non-zero `pocketshell repos …` exit.
 *
 * The exit code alone is not enough. Captured on the fixture (helper 0.4.44):
 *
 *  - `repos list --remote --json` with no `gh` on PATH exits **127** with
 *    "pocketshell: `gh` is not installed on this host. …" on stderr;
 *  - a MISSING `pocketshell` also exits 127, but with the shell's own
 *    "pocketshell: not found".
 *
 * Both are 127, and they mean opposite things to the UI ("install gh, the
 * rest of the app is fine" vs "this host has no helper at all"), so the
 * stderr text is what actually decides. The `gh auth` wording mirrors the
 * phone's `ghUnauthenticated` (AppAssistantActions.kt:514).
 */
export function classifyReposFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
): { state: Exclude<ReposScopeState, 'ok'>; error: string } {
  const text = `${stdout}\n${stderr}`;
  const lower = text.toLowerCase();
  const message = stderr.trim() || stdout.trim() || `pocketshell repos exited ${exitCode}`;

  if (
    lower.includes('not authenticated') ||
    lower.includes('gh auth') ||
    lower.includes('authentication required')
  ) {
    // `gh auth login` appears in the gh-missing message too, so the absent
    // binary must be ruled out first.
    if (!lower.includes('is not installed')) {
      return { state: 'gh-unauthenticated', error: message };
    }
  }
  if (lower.includes('`gh` is not installed') || lower.includes('gh is not installed')) {
    return { state: 'gh-missing', error: message };
  }
  if (isHelperMissing(exitCode, text)) {
    return { state: 'helper-missing', error: message };
  }
  // A Click usage error is a REAL failure, not an absent helper: `failed`
  // carries an error tone in the UI where `helper-missing` reads as "this host
  // just doesn't have it". The host's own line goes out annotated so the user
  // is told which of the two it is.
  return { state: 'failed', error: annotateHelperRejection(message, text) };
}

/**
 * Is this exit the host telling us the `pocketshell` BINARY is absent, rather
 * than the command running and failing?
 *
 * One question only: did the shell fail to find the executable. 127 from
 * `/bin/sh` is "command not found", and the `gh` guard in classifyReposFailure
 * is needed because the helper's own "`gh` is not installed" message also
 * exits 127.
 *
 * Deliberately does NOT treat Click's exit-2 `No such command` /
 * `No such option` as "missing helper": those exits now mean we built the
 * invocation wrong or the binary is a namesake, and treating them as a
 * missing helper would launder a wrong-flag create into a successful-looking
 * one that silently ignored the repo's `cgroups.toml` budget. They are
 * explained by describeHelperRejection and surfaced as failures instead.
 */
export function isHelperMissing(exitCode: number, output: string): boolean {
  const lower = output.toLowerCase();
  if (lower.includes('is not installed')) return false; // a gh message, not a helper one
  return exitCode === 127 && /pocketshell[^\n]*not found|command not found/.test(lower);
}

/**
 * Explain a Click usage error from the helper, or null when the output is not
 * one.
 *
 * Click exits **2** for both of these, and they are different bugs on our side:
 *
 *  - `Error: No such command 'sessions'.` — the group has no such subcommand.
 *    Against 0.4.44 this means the `pocketshell` on that host is not the helper
 *    (a namesake on PATH, a half-installed shim), because every subcommand we
 *    call exists in the version the app targets.
 *  - `Error: No such option: --cwd` — the subcommand exists but rejected a flag
 *    we passed. That is drift between this client and the installed helper.
 *
 * The raw Click line names neither, so a user reading "No such option: --cwd"
 * in a dialog has nothing to act on. The host's own text is still shown; this
 * only adds the sentence that makes it legible.
 */
export function describeHelperRejection(output: string): string | null {
  const lower = output.toLowerCase();
  if (lower.includes('no such command')) {
    return "The `pocketshell` on this host does not have that subcommand — check `pocketshell --version` there (this app targets 0.4.44).";
  }
  if (lower.includes('no such option')) {
    return "The host's `pocketshell` rejected an option this app passed — the app and the installed helper have drifted.";
  }
  return null;
}

/**
 * A host failure message with the usage-error explanation appended, when there
 * is one.
 *
 * Both call sites (repos classification and session creation) compose it the
 * same way, so they share this rather than each inventing their own wording.
 * The newline collapses to a space in the renderer's `<p>` and keeps the two
 * sentences apart in a log.
 */
export function annotateHelperRejection(hostMessage: string, output: string): string {
  const reason = describeHelperRejection(output);
  return reason === null ? hostMessage : `${hostMessage}\n${reason}`;
}
