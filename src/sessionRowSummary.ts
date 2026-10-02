/**
 * Project a host-CLI session row (`pocketshell sessions list --json`, the
 * ConnectionController's listing) into the shared app's `SessionSummary`.
 *
 * The same projection `aplexerRecordToSummary` gives an `a` snapshot row, so
 * a client whose listing comes through the controller files every session
 * under the same folder, tab and agent badge as one listing `a` directly
 * (#2936). Every host-CLI session is an aplexer session: the CLI is the
 * aplexer front end.
 */
import { agentKindFromEngine } from './aplexerParsers';
import type { SessionRow } from './hostCliSessions';
import type { SessionSummary } from './types';

export function sessionRowToSummary(row: SessionRow): SessionSummary {
  const created = row.createdEpoch ?? 0;
  return {
    name: row.tag ?? row.name,
    created,
    activity: row.activityEpoch ?? created,
    attached: row.attached,
    path: row.workspace,
    agentKind: agentKindFromEngine(row.agent) ?? agentKindFromEngine(row.engine),
    backend: 'aplexer',
    workspace: row.workspace,
    tag: row.tag ?? row.name,
    aplexerId: row.id,
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.phase ? { aplexerPhase: row.phase } : {}),
  };
}

/**
 * Find the listed row a shared-app attach request names. The aplexer id wins
 * outright (stable across renames); otherwise the workspace-qualified tag.
 */
export function findSessionRow(
  rows: readonly SessionRow[],
  request: { sessionName: string; workspace?: string | null; tag?: string | null; aplexerId?: string | null },
): SessionRow | null {
  if (request.aplexerId) {
    const byId = rows.find((row) => row.id === request.aplexerId);
    if (byId) return byId;
  }
  const tag = request.tag ?? request.sessionName;
  return (
    rows.find(
      (row) =>
        (row.tag ?? row.name) === tag &&
        (request.workspace == null || row.workspace === request.workspace),
    ) ??
    rows.find((row) => row.name === request.sessionName) ??
    null
  );
}
