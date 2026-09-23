import type { DirEntry } from './sftpCore';

/** Default retention policy for per-session staged attachments. */
export const DEFAULT_ATTACHMENT_RETENTION_POLICY: AttachmentRetentionPolicy = {
  ttlMillis: 7 * 24 * 60 * 60 * 1_000,
  keepNewest: 20,
  protectNewestMillis: 24 * 60 * 60 * 1_000,
};

export interface AttachmentRetentionPolicy {
  /** Files at least this old are eligible for age-based pruning. */
  ttlMillis: number;
  /** Keep at least this many newest files, except files past the TTL. */
  keepNewest: number;
  /** Never delete files newer than this, even if the list is truncated. */
  protectNewestMillis: number;
}

export interface AttachmentPrunePlan<T extends Pick<DirEntry, 'name' | 'type' | 'modifyTime'>> {
  delete: T[];
}

/**
 * Select remote attachment files that may be pruned. Directories and files
 * with absent/invalid modification times are retained. New files inside the
 * protection window survive both the age limit and the count limit.
 */
export function planAttachmentRetention<T extends Pick<DirEntry, 'name' | 'type' | 'modifyTime'>>(
  entries: readonly T[],
  nowMillis: number,
  policy: AttachmentRetentionPolicy = DEFAULT_ATTACHMENT_RETENTION_POLICY,
): AttachmentPrunePlan<T> {
  assertRetentionPolicy(policy);
  if (!Number.isFinite(nowMillis)) throw new Error('nowMillis must be finite');

  const files = entries
    .filter((entry) => entry.type === 'file')
    .filter((entry) => Number.isFinite(entry.modifyTime) && entry.modifyTime > 0)
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      if (left.entry.modifyTime !== right.entry.modifyTime) {
        return right.entry.modifyTime - left.entry.modifyTime;
      }
      if (left.entry.name < right.entry.name) return -1;
      if (left.entry.name > right.entry.name) return 1;
      return left.index - right.index;
    });

  return {
    delete: files
      .filter(({ entry }, newestIndex) => {
        const age = nowMillis - entry.modifyTime;
        if (age < policy.protectNewestMillis) return false;
        return age >= policy.ttlMillis || newestIndex >= policy.keepNewest;
      })
      .map(({ entry }) => entry),
  };
}

export type AttachmentStageAttempt<T> =
  | { kind: 'uploaded'; attachment: T }
  | { kind: 'failed' };

export type AttachmentStageDecision<T> =
  | { kind: 'empty'; attachments: [] }
  | { kind: 'complete'; attachments: T[] }
  | { kind: 'partial'; attachments: T[]; failedCount: number }
  | { kind: 'failed'; attachments: []; failedCount: number }
  | { kind: 'cancelled'; attachments: []; completedUploadCount: number };

/**
 * Decide which successful uploads remain staged after a batch. Partial success
 * retains its successful attachments. Cancellation discards the staged result;
 * `completedUploadCount` lets the caller account for remote files already
 * written before cancellation without referencing them in the draft.
 */
export function decideAttachmentStage<T>(
  attempts: readonly AttachmentStageAttempt<T>[],
  cancelled = false,
): AttachmentStageDecision<T> {
  const uploaded = attempts
    .filter((attempt): attempt is { kind: 'uploaded'; attachment: T } => attempt.kind === 'uploaded')
    .map((attempt) => attempt.attachment);
  const failedCount = attempts.length - uploaded.length;

  if (cancelled) return { kind: 'cancelled', attachments: [], completedUploadCount: uploaded.length };
  if (attempts.length === 0) return { kind: 'empty', attachments: [] };
  if (failedCount === 0) return { kind: 'complete', attachments: uploaded };
  if (uploaded.length === 0) return { kind: 'failed', attachments: [], failedCount };
  return { kind: 'partial', attachments: uploaded, failedCount };
}

function assertRetentionPolicy(policy: AttachmentRetentionPolicy): void {
  if (!Number.isFinite(policy.ttlMillis) || !(policy.ttlMillis > 0)) {
    throw new Error('ttlMillis must be positive and finite');
  }
  if (!Number.isSafeInteger(policy.keepNewest) || !(policy.keepNewest > 0)) {
    throw new Error('keepNewest must be a positive safe integer');
  }
  if (!Number.isFinite(policy.protectNewestMillis) || !(policy.protectNewestMillis >= 0)) {
    throw new Error('protectNewestMillis must be non-negative and finite');
  }
}
