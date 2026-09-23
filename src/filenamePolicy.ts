/**
 * Filename and attachment-path policy shared by client runtimes.
 *
 * This does not create directories, read device documents, or transfer bytes.
 * It only turns untrusted display names and scope identifiers into bounded
 * remote path components.
 */

export const MAX_SANITIZED_FILENAME_LENGTH = 200;
export const DEFAULT_SANITIZED_FILENAME = 'shared';
export const MAX_SANITIZED_EXTENSION_LENGTH = 16;

export interface SanitizedFilename {
  /** Filename stem without a dot. */
  base: string;
  /** Extension without a dot, possibly empty. */
  ext: string;
}

export function renderSanitizedFilename(name: SanitizedFilename): string {
  return name.ext === '' ? name.base : `${name.base}.${name.ext}`;
}

/**
 * Reduce an untrusted path/display name to one safe, bounded filename.
 * Both slash styles are treated as source path separators. Unicode letters
 * and digits are retained; shell punctuation and controls are replaced.
 */
export function sanitizeFilename(
  input: string | null | undefined,
  defaultExtension?: string | null,
): SanitizedFilename {
  const raw = input ?? '';
  const basename = afterLast(afterLast(raw, '/'), '\\');
  const whitespaceCollapsed = basename.replace(/\s+/g, '_');

  let printable = '';
  for (const character of whitespaceCollapsed) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) printable += character;
  }

  const dot = printable.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < printable.length - 1;
  const stem = hasExtension ? printable.slice(0, dot) : trimChars(printable, '.');
  const extension = hasExtension ? printable.slice(dot + 1) : '';

  const cleanStem = sanitizeSegment(stem);
  const cleanExtension = takeCodePointsByUnits(sanitizeSegment(extension), MAX_SANITIZED_EXTENSION_LENGTH);
  const safeStem = cleanStem === '' || /^\.+$/.test(cleanStem)
    ? DEFAULT_SANITIZED_FILENAME
    : cleanStem;
  const fallbackExtension = defaultExtension == null
    ? ''
    : takeCodePointsByUnits(sanitizeSegment(defaultExtension), MAX_SANITIZED_EXTENSION_LENGTH);
  const resolvedExtension = cleanExtension || fallbackExtension;

  const extensionUnits = codeUnitLength(resolvedExtension);
  const stemLimit = Math.max(MAX_SANITIZED_FILENAME_LENGTH - (resolvedExtension ? extensionUnits + 1 : 0), 1);
  return {
    base: takeCodePointsByUnits(safeStem, stemLimit),
    ext: resolvedExtension,
  };
}

/** Make the per-session attachment folder component used by the Android flow. */
export function sanitizeAttachmentScope(scopeKey: string): string {
  let mapped = '';
  for (const character of scopeKey) {
    if (character >= 'A' && character <= 'Z') mapped += character.toLowerCase();
    else if (
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '_'
    ) mapped += character;
    else mapped += '-';
  }
  const clean = mapped.replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  return clean || 'session';
}

/** Compose `<timestamp>-NN-<sanitized filename>` for one picked file. */
export function composeAttachmentFilename(
  timestamp: string,
  zeroBasedIndex: number,
  filename: SanitizedFilename,
): string {
  if (!/^\d{8}-\d{6}$/.test(timestamp)) throw new Error('timestamp must be yyyyMMdd-HHmmss');
  if (!Number.isSafeInteger(zeroBasedIndex) || zeroBasedIndex < 0 || zeroBasedIndex >= Number.MAX_SAFE_INTEGER) {
    throw new Error('zeroBasedIndex must be a non-negative safe integer');
  }
  const ordinal = String(zeroBasedIndex + 1).padStart(2, '0');
  return `${timestamp}-${ordinal}-${renderSanitizedFilename(filename)}`;
}

function sanitizeSegment(segment: string): string {
  let mapped = '';
  for (const character of segment) {
    if (isAllowed(character)) mapped += character;
    else mapped += '_';
  }
  return trimChars(mapped.replace(/_+/g, '_'), '_.-');
}

function isAllowed(character: string): boolean {
  if (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') ||
    character === '.' || character === '_' || character === '-'
  ) return true;
  const code = character.codePointAt(0) ?? 0;
  return code > 0x7f && /[\p{L}\p{N}]/u.test(character);
}

function afterLast(value: string, separator: string): string {
  const index = value.lastIndexOf(separator);
  return index === -1 ? value : value.slice(index + 1);
}

function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start]!)) start += 1;
  while (end > start && chars.includes(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

function codeUnitLength(value: string): number {
  return value.length;
}

function takeCodePointsByUnits(value: string, maxUnits: number): string {
  let result = '';
  let used = 0;
  for (const character of value) {
    if (used + character.length > maxUnits) break;
    result += character;
    used += character.length;
  }
  return result;
}
