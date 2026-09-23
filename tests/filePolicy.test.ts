import { describe, expect, it } from 'vitest';
import type { DirEntry } from '../src/sftpCore';
import {
  classifyFileByName,
  classifyFileBytes,
  classifyFileMagic,
  evaluateFileEditSave,
  extensionOfRemotePath,
  hasFilePreview,
  isEditableFileKind,
  isMarkdownRemotePath,
  looksLikeRemoteText,
  sortFileEntries,
  type RemoteFileMetadata,
} from '../src/filePolicy';

describe('file classification', () => {
  it('classifies common source, document and media names without reading bytes', () => {
    expect(classifyFileByName('/tmp/README')).toEqual({ kind: 'text', mime: 'text/plain' });
    expect(classifyFileByName('/tmp/.gitconfig')).toEqual({ kind: 'text', mime: 'text/plain' });
    expect(classifyFileByName('/tmp/notes.MD')).toEqual({ kind: 'markdown', mime: 'text/markdown' });
    expect(classifyFileByName('/tmp/page.xhtml').kind).toBe('html');
    expect(classifyFileByName('/tmp/diagram.svg').kind).toBe('svg');
    expect(classifyFileByName('/tmp/report.pdf').kind).toBe('pdf');
    expect(classifyFileByName('/tmp/sound.ogg').kind).toBe('audio');
    expect(classifyFileByName('/tmp/photo.webp').kind).toBe('image');
    expect(classifyFileByName('/tmp/archive.zip').kind).toBe('binary');
    expect(classifyFileByName('/tmp/mystery.zzz')).toEqual({ kind: 'unknown', mime: null });
  });

  it('extracts extensions without treating dotfiles or trailing dots as extensions', () => {
    expect(extensionOfRemotePath('/tmp/file.TXT')).toBe('txt');
    expect(extensionOfRemotePath('/tmp/.env')).toBeNull();
    expect(extensionOfRemotePath('/tmp/file.')).toBeNull();
    expect(isMarkdownRemotePath('/tmp/README.mdown')).toBe(true);
    expect(isMarkdownRemotePath('/tmp/README.mdtext')).toBe(true);
  });

  it('uses bytes only to refine unknown names and recognizes common signatures', () => {
    const unknown = classifyFileByName('/tmp/payload.unknown');
    expect(classifyFileBytes(unknown, new TextEncoder().encode('hello\n')))
      .toEqual({ kind: 'text', mime: 'text/plain' });
    expect(classifyFileBytes(unknown, Uint8Array.from([0, 1, 2])))
      .toEqual({ kind: 'binary', mime: null });
    expect(classifyFileBytes(unknown, Uint8Array.from([0x89, 0x50, 0x4e, 0x47])))
      .toEqual({ kind: 'image', mime: 'image/png' });
    expect(classifyFileMagic(Uint8Array.from([0x25, 0x50, 0x44, 0x46])))
      .toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(classifyFileMagic(Uint8Array.from([0x50, 0x4b, 3, 4])))
      .toEqual({ kind: 'binary', mime: 'application/zip' });
  });

  it('requires valid UTF-8 and rejects NUL or excessive control bytes', () => {
    expect(looksLikeRemoteText(new TextEncoder().encode('hello\tworld\n'))).toBe(true);
    expect(looksLikeRemoteText(Uint8Array.from([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeRemoteText(Uint8Array.from([0xff, 0xfe]))).toBe(false);
    expect(looksLikeRemoteText(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(false);
  });

  it('marks editable and previewable document kinds consistently', () => {
    expect(isEditableFileKind('text')).toBe(true);
    expect(isEditableFileKind('markdown')).toBe(true);
    expect(isEditableFileKind('image')).toBe(false);
    expect(hasFilePreview('html')).toBe(true);
    expect(hasFilePreview('svg')).toBe(true);
    expect(hasFilePreview('text')).toBe(false);
  });
});

describe('sortFileEntries', () => {
  const entry = (name: string, type: DirEntry['type']): Pick<DirEntry, 'name' | 'type'> => ({ name, type });

  it('places directories first and uses deterministic case-folded name order', () => {
    expect(sortFileEntries([
      entry('z.txt', 'file'),
      entry('beta', 'dir'),
      entry('A.txt', 'file'),
      entry('alpha', 'dir'),
      entry('link', 'symlink'),
    ])).toEqual([
      entry('alpha', 'dir'),
      entry('beta', 'dir'),
      entry('A.txt', 'file'),
      entry('link', 'symlink'),
      entry('z.txt', 'file'),
    ]);
  });

  it('does not mutate the server listing and retains duplicate input order', () => {
    const input = [entry('same', 'file'), entry('same', 'file')];
    const output = sortFileEntries(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });
});

describe('evaluateFileEditSave', () => {
  const loaded: RemoteFileMetadata = { isDirectory: false, sizeBytes: 12, modifiedEpochMs: 50_000 };

  it('allows a write only when fresh remote metadata matches the loaded version', () => {
    expect(evaluateFileEditSave(loaded, { ...loaded })).toBe('unchanged');
    expect(evaluateFileEditSave(loaded, { ...loaded, sizeBytes: 13 })).toBe('changed');
    expect(evaluateFileEditSave(loaded, { ...loaded, modifiedEpochMs: 51_000 })).toBe('changed');
    expect(evaluateFileEditSave(loaded, { ...loaded, isDirectory: true })).toBe('changed');
  });

  it('blocks missing and unverifiable metadata instead of guessing', () => {
    expect(evaluateFileEditSave(loaded, null)).toBe('missing');
    expect(evaluateFileEditSave(null, loaded)).toBe('unverifiable');
    expect(evaluateFileEditSave(loaded, { ...loaded, modifiedEpochMs: 0 })).toBe('unverifiable');
    expect(evaluateFileEditSave(loaded, { ...loaded, sizeBytes: Number.NaN })).toBe('unverifiable');
  });
});
