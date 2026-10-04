/**
 * The client-exit verdict for an aplexer pane (#3039).
 *
 * An aplexer pane's PTY runs an attach CLIENT (`pocketshell sessions attach`
 * → `a attach`), not the session. When that client exits, two very different
 * things look identical from the pane: the SESSION ended (killed, or its
 * workload exited) and the client merely dropped while the session carries
 * on. Both arrive as a clean exit on a healthy transport — the controller
 * reports both as "Session … ended" — so the exit itself cannot tell them
 * apart. Only the host can: a fresh listing taken after the exit.
 *
 * aplexer writes a killed session's record as `exiting` BEFORE it signals the
 * workload, and removes the record once the workload is gone. So at any
 * moment after a session-end exit the listing either no longer names the
 * session, or names it in an ending phase; the host CLI, however, lists
 * `exiting` sessions among the live ones, so presence alone is not enough.
 *
 * The verdict is deliberately one-sided: a re-attach needs POSITIVE evidence
 * that this very session is still running. Anything else — absent, ending,
 * an identity that no longer matches — reads as the session having ended,
 * which is what the pane said before the silent re-join existed.
 */
import type { SessionSummary } from './types';

/** aplexer phases of a session that is going or gone. */
const ENDING_APLEXER_PHASES: ReadonlySet<string> = new Set(['exiting', 'exited', 'failed']);

/** The session a pane was showing when its attach client exited. */
export interface ClientExitTarget {
  /** The pane's target name (the aplexer tag on an aplexer pane). */
  sessionName: string;
  workspace?: string | null;
  aplexerId?: string | null;
}

/**
 * Whether the listing still names `target` in a phase where its client's
 * exit can only have been the client dropping. When the pane knows the
 * session's aplexer id, only that id matches: a NEW session that reuses the
 * tag is not the one whose client exited, and re-joining it silently would
 * put the user in a different session.
 */
export function sessionOutlivedClient(
  listing: readonly SessionSummary[],
  target: ClientExitTarget,
): boolean {
  const row = target.aplexerId
    ? listing.find((summary) => summary.aplexerId === target.aplexerId)
    : listing.find(
        (summary) =>
          (summary.tag ?? summary.name) === target.sessionName &&
          (target.workspace == null || summary.workspace === target.workspace),
      );
  if (!row) return false;
  // A host that reports no phase lists live sessions only; presence is then
  // the whole answer.
  const phase = row.aplexerPhase?.trim().toLowerCase();
  return !phase || !ENDING_APLEXER_PHASES.has(phase);
}
