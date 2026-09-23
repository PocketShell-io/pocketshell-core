import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANITIZED_FILENAME,
  MAX_SANITIZED_FILENAME_LENGTH,
  composeAttachmentFilename,
  renderSanitizedFilename,
  sanitizeAttachmentScope,
  sanitizeFilename,
} from '../src/filenamePolicy';

const render = (input: string | null | undefined, extension?: string | null): string =>
  renderSanitizedFilename(sanitizeFilename(input, extension));

describe('sanitizeFilename', () => {
  it('keeps only the final path component', () => {
    expect(render('../../../etc/passwd')).toBe('passwd');
    expect(render('..\\..\\Windows\\System32\\hosts')).toBe('hosts');
  });

  it('removes NUL and control characters and preserves whitespace boundaries', () => {
    expect(render('safe\0name.txt')).toBe('safename.txt');
    expect(render('foo\u0007bar\u001b.txt')).toBe('foobar.txt');
    expect(render('a\n\tb.txt')).toBe('a_b.txt');
  });

  it('collapses shell punctuation and keeps Unicode letters and digits', () => {
    expect(render('report (final).docx')).toBe('report_final.docx');
    expect(render('отчёт 日本語 2.png')).toBe('отчёт_日本語_2.png');
    expect(render('happy😀.png')).toBe('happy.png');
  });

  it('handles dotfiles and trailing dots without inventing an extension', () => {
    expect(render('.bashrc')).toBe('bashrc');
    expect(render('notes.')).toBe('notes');
    expect(render('...')).toBe(DEFAULT_SANITIZED_FILENAME);
    expect(render(null)).toBe(DEFAULT_SANITIZED_FILENAME);
    expect(render('')).toBe(DEFAULT_SANITIZED_FILENAME);
  });

  it('preserves a real extension and sanitizes an optional default extension', () => {
    expect(render('archive.tar.gz')).toBe('archive.tar.gz');
    expect(render('screenshot', 'png')).toBe('screenshot.png');
    expect(render('diagram.svg', 'png')).toBe('diagram.svg');
    expect(render('shot', '../png')).toBe('shot.png');
  });

  it('bounds the total filename length and does not split a surrogate pair', () => {
    const result = sanitizeFilename(`${'a'.repeat(300)}.txt`);
    expect(renderSanitizedFilename(result).length).toBe(MAX_SANITIZED_FILENAME_LENGTH);
    expect(result.ext).toBe('txt');
    const unicode = sanitizeFilename(`${'a'.repeat(199)}𝟙`);
    expect(unicode.base).toBe('a'.repeat(199));
    expect(unicode.base).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe('attachment path naming', () => {
  it('normalizes scope ids into one bounded path component', () => {
    expect(sanitizeAttachmentScope('Host/A:Main')).toBe('host-a-main');
    expect(sanitizeAttachmentScope('---')).toBe('session');
    expect(sanitizeAttachmentScope('x'.repeat(100))).toHaveLength(80);
    expect(sanitizeAttachmentScope('../..')).toBe('session');
  });

  it('composes indexed names and rejects unsafe timestamp or index values', () => {
    expect(composeAttachmentFilename('20260923-123456', 0, sanitizeFilename('photo.png')))
      .toBe('20260923-123456-01-photo.png');
    expect(composeAttachmentFilename('20260923-123456', 10, sanitizeFilename('README')))
      .toBe('20260923-123456-11-README');
    expect(() => composeAttachmentFilename('../x', 0, sanitizeFilename('a'))).toThrow(/timestamp/);
    expect(() => composeAttachmentFilename('20260923-123456', -1, sanitizeFilename('a')))
      .toThrow(/zeroBasedIndex/);
  });
});
