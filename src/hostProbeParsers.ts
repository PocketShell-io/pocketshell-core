/**
 * Pure line parsers for the small host probes that are not session-shaped:
 * `command -v` bootstrap probes and the raw-tmux sessions fallback.
 *
 * These are the desktop main process's helpers (src/main/helper/cliParsers.ts,
 * parsers.ts) lifted into core so the browser transport can run the SAME
 * probes with the SAME parsing — a host answers identically whichever client
 * asks, so the parsing cannot be allowed to drift either.
 */

import type { EnvVarRow, SessionSummary } from './types';

/**
 * Parse `command -v <binary>` output into an absolute path, or null if the
 * binary is absent. The probe is run as `command -v pocketshell`; exit 0 +
 * non-empty stdout means installed, anything else means missing.
 */
export function parseCommandV(stdout: string, exitCode: number): string | null {
  if (exitCode !== 0) return null;
  const path = stdout.trim().split(/\r?\n/)[0];
  return path && path.length > 0 ? path : null;
}

/**
 * The first non-empty line of [text], trimmed — or null when there is none.
 *
 * The shape every "the CLI echoes its answer on stdout" call site used to
 * re-derive: createSession's echoed name, reposClone's printed path,
 * `canonicalise`'s resolved directory.
 */
export function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** The last non-empty line of [text], trimmed — or null when there is none. */
export function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Parse the `tmux list-sessions -F` fallback (`::`-delimited):
 *   session_name::created_epoch::activity_epoch::attached_count[:path]
 *
 * The arm a host WITHOUT the helper (and without aplexer) takes: raw tmux,
 * names and epochs only. This shape carries no `@ps_agent_kind` — rows come
 * back with `agentKind: null`, which the session panel renders as a plain
 * shell row.
 */
export function parseTmuxListSessionsFallback(stdout: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('no server')) continue;
    const parts = line.split('::');
    const [name, created, activity, attached, path] = parts;
    if (!name || created === undefined || activity === undefined) continue;
    const createdNum = Number.parseInt(created, 10);
    const activityNum = Number.parseInt(activity, 10);
    const attachedNum = attached === undefined ? NaN : Number.parseInt(attached, 10);
    if (!name || !Number.isFinite(createdNum)) continue;
    out.push({
      name,
      created: createdNum,
      activity: Number.isFinite(activityNum) ? activityNum : createdNum,
      attached: Number.isFinite(attachedNum) && attachedNum > 0,
      path: path && path !== '' ? path : null,
      // This shape carries no `@ps_agent_kind`; the companion probe supplies it.
      agentKind: null,
    });
  }
  return out;
}

/**
 * One `pocketshell env list --json` row — `{file, has_value, key}`, names
 * only, never values (the helper's write-only default, D24).
 */
export function parseEnvVarRow(row: unknown): EnvVarRow | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const doc = row as Record<string, unknown>;
  if (typeof doc['key'] !== 'string' || doc['key'].length === 0) return undefined;
  return {
    file: typeof doc['file'] === 'string' ? doc['file'] : '',
    hasValue: doc['has_value'] === true,
    key: doc['key'],
  };
}
