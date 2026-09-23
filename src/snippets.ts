/**
 * Host-owned snippets and command templates shared by Android, web, and
 * desktop. `hostId` is the durable host identity, not a display name or SSH
 * alias: selecting data for one host must never widen to another host.
 *
 * The policies in this module are pure. Persistence, editing UI, and applying
 * a returned insertion to a composer draft belong to the client adapters.
 */

export interface HostSnippet {
  id: string;
  hostId: string;
  label: string | null;
  /** Literal snippet content. Newlines and surrounding whitespace are data. */
  body: string;
  /** Kept open so an older client can preserve a kind added by a newer one. */
  kind: string;
  /** Position in this host's list. Equal positions retain input order. */
  sortOrder: number;
}

export interface HostCommandTemplate {
  id: string;
  hostId: string;
  label: string;
  /** Literal command/template content; this policy never submits it. */
  commands: string;
  /** Position in this host's list. Equal positions retain input order. */
  sortOrder: number;
}

export interface HostOrderedItem {
  id: string;
  hostId: string;
  sortOrder: number;
}

export type LegacySnippetParseResult =
  | { kind: 'ok'; snippets: HostSnippet[] }
  | { kind: 'invalid'; reason: LegacySnippetInvalidReason; index?: number };

export type LegacyCommandTemplateParseResult =
  | { kind: 'ok'; templates: HostCommandTemplate[] }
  | { kind: 'invalid'; reason: LegacySnippetInvalidReason; index?: number };

export type LegacySnippetInvalidReason =
  | 'invalid-shape'
  | 'invalid-row'
  | 'invalid-id'
  | 'duplicate-id'
  | 'invalid-host-id'
  | 'unknown-host-id'
  | 'invalid-label'
  | 'invalid-body'
  | 'invalid-kind';

export type HostOrderResult<T> =
  | { kind: 'ok'; items: T[] }
  | { kind: 'invalid'; reason: 'invalid-host-id' | 'invalid-order' };

/**
 * Read Room's `snippets` rows from the installed-data snapshot.
 *
 * Room stores primary and foreign keys as positive integers. They become
 * decimal strings at the shared JS boundary, preserving the durable host ID.
 * The native reader supplies rows in its chosen read order; that order is
 * assigned explicitly so it survives sorting in JS storage. A malformed row
 * rejects the complete collection instead of silently dropping user data.
 */
export function parseLegacySnippets(
  value: unknown,
  knownHostIds: readonly number[],
): LegacySnippetParseResult {
  if (!Array.isArray(value) || !validLegacyHostIds(knownHostIds)) {
    return { kind: 'invalid', reason: 'invalid-shape' };
  }

  const hosts = new Set(knownHostIds);
  const ids = new Set<number>();
  const snippets: HostSnippet[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate: unknown = value[index];
    if (!isRecord(candidate)) return { kind: 'invalid', reason: 'invalid-row', index };
    const row = candidate;
    if (!isPositiveSafeInteger(row.id)) return { kind: 'invalid', reason: 'invalid-id', index };
    if (ids.has(row.id)) return { kind: 'invalid', reason: 'duplicate-id', index };
    if (!isPositiveSafeInteger(row.hostId)) return { kind: 'invalid', reason: 'invalid-host-id', index };
    if (!hosts.has(row.hostId)) return { kind: 'invalid', reason: 'unknown-host-id', index };
    if (row.label !== null && typeof row.label !== 'string') {
      return { kind: 'invalid', reason: 'invalid-label', index };
    }
    if (typeof row.body !== 'string') return { kind: 'invalid', reason: 'invalid-body', index };
    if (typeof row.kind !== 'string') return { kind: 'invalid', reason: 'invalid-kind', index };

    ids.add(row.id);
    snippets.push({
      id: String(row.id),
      hostId: String(row.hostId),
      label: row.label,
      body: row.body,
      kind: row.kind,
      sortOrder: index,
    });
  }
  return { kind: 'ok', snippets };
}

/**
 * Read Room's `command_templates` rows with the same strict host association
 * and all-or-nothing validation as {@link parseLegacySnippets}.
 */
export function parseLegacyCommandTemplates(
  value: unknown,
  knownHostIds: readonly number[],
): LegacyCommandTemplateParseResult {
  if (!Array.isArray(value) || !validLegacyHostIds(knownHostIds)) {
    return { kind: 'invalid', reason: 'invalid-shape' };
  }

  const hosts = new Set(knownHostIds);
  const ids = new Set<number>();
  const templates: HostCommandTemplate[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate: unknown = value[index];
    if (!isRecord(candidate)) return { kind: 'invalid', reason: 'invalid-row', index };
    const row = candidate;
    if (!isPositiveSafeInteger(row.id)) return { kind: 'invalid', reason: 'invalid-id', index };
    if (ids.has(row.id)) return { kind: 'invalid', reason: 'duplicate-id', index };
    if (!isPositiveSafeInteger(row.hostId)) return { kind: 'invalid', reason: 'invalid-host-id', index };
    if (!hosts.has(row.hostId)) return { kind: 'invalid', reason: 'unknown-host-id', index };
    if (typeof row.label !== 'string') return { kind: 'invalid', reason: 'invalid-label', index };
    if (typeof row.commands !== 'string') return { kind: 'invalid', reason: 'invalid-body', index };

    ids.add(row.id);
    templates.push({
      id: String(row.id),
      hostId: String(row.hostId),
      label: row.label,
      commands: row.commands,
      sortOrder: index,
    });
  }
  return { kind: 'ok', templates };
}

/** Return one host's items in saved order without changing the source array. */
export function orderedItemsForHost<T extends HostOrderedItem>(
  items: readonly T[],
  hostId: string,
): T[] {
  if (!isNonEmptyIdentity(hostId)) return [];
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.hostId === hostId)
    .sort((left, right) => {
      if (left.item.sortOrder !== right.item.sortOrder) {
        return left.item.sortOrder - right.item.sortOrder;
      }
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

/** Host-scoped convenience lookup for Room-compatible snippets. */
export function snippetsForHost(
  snippets: readonly HostSnippet[],
  hostId: string,
): HostSnippet[] {
  return orderedItemsForHost(snippets, hostId);
}

/** Host-scoped convenience lookup for imported command templates. */
export function commandTemplatesForHost(
  templates: readonly HostCommandTemplate[],
  hostId: string,
): HostCommandTemplate[] {
  return orderedItemsForHost(templates, hostId);
}

/**
 * Apply a user's complete reorder for one host. The order must name each
 * current item exactly once; an invalid update leaves every host unchanged.
 */
export function reorderHostItems<T extends HostOrderedItem>(
  items: readonly T[],
  hostId: string,
  orderedIds: readonly string[],
): HostOrderResult<T> {
  if (!isNonEmptyIdentity(hostId)) return { kind: 'invalid', reason: 'invalid-host-id' };
  const current = orderedItemsForHost(items, hostId);
  const currentIds = new Set(current.map((item) => item.id));
  const requestedIds = new Set(orderedIds);
  if (
    currentIds.size !== current.length ||
    requestedIds.size !== orderedIds.length ||
    requestedIds.size !== currentIds.size ||
    [...requestedIds].some((id) => !currentIds.has(id))
  ) {
    return { kind: 'invalid', reason: 'invalid-order' };
  }

  const positionById = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    kind: 'ok',
    items: items.map((item) => {
      if (item.hostId !== hostId) return item;
      const sortOrder = positionById.get(item.id);
      // The exact-permutation check above proves this lookup exists.
      return { ...item, sortOrder: sortOrder! };
    }),
  };
}

/**
 * Draft insertion action produced by tapping a snippet chip. The explicit
 * `submit: false` means the adapter writes `text` into the current draft only;
 * this core policy has no PTY or Enter operation.
 */
export interface LiteralDraftInsertion {
  kind: 'insert-literal';
  text: string;
  submit: false;
}

/** Return exact snippet bytes as draft text; do not append a newline or submit. */
export function snippetInsertion(snippet: Pick<HostSnippet, 'body'>): LiteralDraftInsertion {
  return { kind: 'insert-literal', text: snippet.body, submit: false };
}

/** Return exact template bytes as draft text; do not append a newline or submit. */
export function commandTemplateInsertion(
  template: Pick<HostCommandTemplate, 'commands'>,
): LiteralDraftInsertion {
  return { kind: 'insert-literal', text: template.commands, submit: false };
}

function validLegacyHostIds(hostIds: readonly number[]): boolean {
  return hostIds.every(isPositiveSafeInteger);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyIdentity(value: string): boolean {
  return value.trim().length > 0;
}
