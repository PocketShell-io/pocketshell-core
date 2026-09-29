import { describe, expect, it } from 'vitest';
import { createAttachmentUploadProgressTracker } from '../src/attachmentUploadProgress';

describe('createAttachmentUploadProgressTracker', () => {
  it('aggregates monotonically increasing acknowledged bytes and finishes at the payload size', () => {
    const progress = createAttachmentUploadProgressTracker([
      { name: 'first.bin', sizeBytes: 5 },
      { name: 'second.bin', sizeBytes: 3 },
    ]);

    expect(progress.report(0, 2, 5)).toMatchObject({
      fileName: 'first.bin', fileIndex: 0, fileCount: 2,
      fileBytesWritten: 2, batchBytesWritten: 2, batchBytesTotal: 8,
    });
    expect(progress.report(0, 1, 5)).toBeNull();
    expect(progress.report(0, 6, 5)).toBeNull();
    expect(progress.report(1, 1, 3)).toBeNull();
    expect(progress.report(0, 5, 5)?.batchBytesWritten).toBe(5);

    expect(progress.complete(0, 5)).toMatchObject({ completedFileCount: 1, batchBytesWritten: 5 });
    expect(progress.report(1, 2, 3)).toMatchObject({
      fileName: 'second.bin', fileIndex: 1, fileBytesWritten: 2,
      batchBytesWritten: 7, batchBytesTotal: 8,
    });
    expect(progress.complete(1, 3)).toMatchObject({
      fileBytesWritten: 3, batchBytesWritten: 8, batchBytesTotal: 8, completedFileCount: 2,
    });
    expect(progress.report(1, 3, 3)).toBeNull();
  });

  it('does not invent empty-file ticks and stops the whole batch after a write failure', () => {
    const progress = createAttachmentUploadProgressTracker([
      { name: 'empty.bin', sizeBytes: 0 },
      { name: 'failed.bin', sizeBytes: 4 },
      { name: 'later.bin', sizeBytes: 2 },
    ]);

    expect(progress.report(0, 0, 0)).toBeNull();
    expect(progress.complete(0, 0)).toBeNull();
    expect(progress.report(1, 2, 4)).toMatchObject({ fileName: 'failed.bin', batchBytesWritten: 2 });
    progress.fail(1);
    expect(progress.report(1, 4, 4)).toBeNull();
    expect(progress.report(2, 1, 2)).toBeNull();
    expect(progress.complete(2, 2)).toBeNull();
  });

  it('stops reporting when the transport closes', () => {
    const progress = createAttachmentUploadProgressTracker([{ name: 'payload.bin', sizeBytes: 8 }]);
    expect(progress.report(0, 4, 8)?.fileBytesWritten).toBe(4);
    progress.stop();
    expect(progress.report(0, 8, 8)).toBeNull();
    expect(progress.complete(0, 8)).toBeNull();
  });
});
