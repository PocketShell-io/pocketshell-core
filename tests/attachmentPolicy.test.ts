import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_RETENTION_POLICY,
  decideAttachmentStage,
  planAttachmentRetention,
  type AttachmentRetentionPolicy,
} from '../src/attachmentPolicy';

const NOW = 1_700_000_000_000;
const hour = (count: number): number => count * 60 * 60 * 1_000;
const day = (count: number): number => count * 24 * hour(1);
const file = (name: string, modifyTime: number) => ({ name, type: 'file' as const, modifyTime });
const policy = (overrides: Partial<AttachmentRetentionPolicy>): AttachmentRetentionPolicy => ({
  ...DEFAULT_ATTACHMENT_RETENTION_POLICY,
  ...overrides,
});

describe('planAttachmentRetention', () => {
  it('retains recent staged files even when over the TTL and newest-file cap', () => {
    const plan = planAttachmentRetention(
      [file('recent-a', NOW - 1), file('recent-b', NOW - hour(1) + 1)],
      NOW,
      policy({ ttlMillis: 1, keepNewest: 1, protectNewestMillis: hour(1) }),
    );
    expect(plan.delete).toEqual([]);
  });

  it('prunes expired files and keeps the newest count outside the safety window', () => {
    const entries = [
      file('oldest', NOW - day(4)),
      file('newest', NOW - day(2)),
      file('middle', NOW - day(3)),
    ];
    const plan = planAttachmentRetention(
      entries,
      NOW,
      policy({ ttlMillis: day(10), keepNewest: 2, protectNewestMillis: hour(1) }),
    );
    expect(plan.delete.map(({ name }) => name)).toEqual(['oldest']);
  });

  it('ignores directories and entries with missing mtimes', () => {
    const plan = planAttachmentRetention([
      { name: 'directory', type: 'dir', modifyTime: 1 },
      file('unknown-time', 0),
      file('expired', NOW - day(30)),
    ], NOW);
    expect(plan.delete.map(({ name }) => name)).toEqual(['expired']);
  });

  it('rejects invalid policies and non-finite clock values', () => {
    expect(() => planAttachmentRetention([], NOW, policy({ keepNewest: 0 }))).toThrow(/keepNewest/);
    expect(() => planAttachmentRetention([], NOW, policy({ ttlMillis: 0 }))).toThrow(/ttlMillis/);
    expect(() => planAttachmentRetention([], NOW, policy({ protectNewestMillis: -1 })))
      .toThrow(/protectNewestMillis/);
    expect(() => planAttachmentRetention([], Number.NaN)).toThrow(/nowMillis/);
  });
});

describe('decideAttachmentStage', () => {
  it('retains successful uploads from a partial batch in source order', () => {
    expect(decideAttachmentStage([
      { kind: 'uploaded', attachment: 'a.png' },
      { kind: 'failed' },
      { kind: 'uploaded', attachment: 'c.png' },
    ])).toEqual({ kind: 'partial', attachments: ['a.png', 'c.png'], failedCount: 1 });
  });

  it('distinguishes empty, complete and total failure', () => {
    expect(decideAttachmentStage([])).toEqual({ kind: 'empty', attachments: [] });
    expect(decideAttachmentStage([{ kind: 'uploaded', attachment: 'a' }]))
      .toEqual({ kind: 'complete', attachments: ['a'] });
    expect(decideAttachmentStage([{ kind: 'failed' }, { kind: 'failed' }]))
      .toEqual({ kind: 'failed', attachments: [], failedCount: 2 });
  });

  it('does not attach earlier successes after cancellation', () => {
    expect(decideAttachmentStage([
      { kind: 'uploaded', attachment: 'already-on-host' },
      { kind: 'failed' },
    ], true)).toEqual({ kind: 'cancelled', attachments: [], completedUploadCount: 1 });
  });
});
