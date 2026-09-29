/** A source file that participates in a sequential attachment upload batch. */
export interface AttachmentUploadProgressFile {
  name: string;
  sizeBytes: number;
}

/** Byte counts accumulated only from acknowledged SFTP writes or final acks. */
export interface AttachmentUploadProgressSnapshot {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  fileBytesWritten: number;
  fileBytesTotal: number;
  batchBytesWritten: number;
  batchBytesTotal: number;
  completedFileCount: number;
}

/**
 * Track the sequential SFTP callbacks for one staging batch. It has no clock
 * or estimated-rate path: every byte advance must come from an acknowledged
 * native write callback, with a successful final ack allowed to confirm the
 * payload size.
 */
export function createAttachmentUploadProgressTracker(files: readonly AttachmentUploadProgressFile[]) {
  const sources = files.map((file) => {
    if (typeof file.name !== 'string') throw new TypeError('Upload progress file names must be strings.');
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new RangeError('Upload progress file sizes must be non-negative safe integers.');
    }
    return { name: file.name, sizeBytes: file.sizeBytes };
  });
  const written = sources.map(() => 0);
  let activeIndex = 0;
  let completedFileCount = 0;
  let active = true;

  function snapshot(fileIndex: number): AttachmentUploadProgressSnapshot {
    return {
      fileName: sources[fileIndex]!.name,
      fileIndex,
      fileCount: sources.length,
      fileBytesWritten: written[fileIndex]!,
      fileBytesTotal: sources[fileIndex]!.sizeBytes,
      batchBytesWritten: written.reduce((total, count) => total + count, 0),
      batchBytesTotal: sources.reduce((total, file) => total + file.sizeBytes, 0),
      completedFileCount,
    };
  }

  function report(fileIndex: number, bytesWritten: number, totalBytes: number): AttachmentUploadProgressSnapshot | null {
    const source = sources[fileIndex];
    if (!active || source == null || fileIndex !== activeIndex || source.sizeBytes === 0) return null;
    if (totalBytes !== source.sizeBytes
        || !Number.isSafeInteger(bytesWritten)
        || bytesWritten <= written[fileIndex]!
        || bytesWritten > source.sizeBytes) return null;
    written[fileIndex] = bytesWritten;
    return snapshot(fileIndex);
  }

  function complete(fileIndex: number, bytesWritten: number): AttachmentUploadProgressSnapshot | null {
    const source = sources[fileIndex];
    if (!active || source == null || fileIndex !== activeIndex || bytesWritten !== source.sizeBytes) return null;
    written[fileIndex] = bytesWritten;
    completedFileCount += 1;
    const completed = source.sizeBytes === 0 ? null : snapshot(fileIndex);
    activeIndex += 1;
    return completed;
  }

  function fail(fileIndex: number): void {
    if (!active || sources[fileIndex] == null || fileIndex !== activeIndex) return;
    active = false;
  }

  function stop(): void {
    active = false;
  }

  return { report, complete, fail, stop };
}
