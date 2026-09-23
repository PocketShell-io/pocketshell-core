import type { DirEntry } from './sftpCore';

/** Kinds a file view may route to without looking at file contents. */
export type FileKind = 'text' | 'image' | 'audio' | 'pdf' | 'html' | 'markdown' | 'svg' | 'binary' | 'unknown';

export interface FileClassification {
  kind: FileKind;
  mime: string | null;
}

export interface RemoteFileMetadata {
  isDirectory: boolean;
  sizeBytes: number;
  modifiedEpochMs: number;
}

export type FileEditSaveVerdict = 'unchanged' | 'changed' | 'missing' | 'unverifiable';

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'rst', 'adoc', 'org', 'log', 'out', 'err', 'diff', 'patch',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'csv', 'tsv', 'xml', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts',
  'cts', 'tsx', 'vue', 'svelte', 'mdx', 'py', 'pyi', 'rb', 'php', 'pl', 'pm', 'lua', 'r',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'rs', 'go', 'java', 'kt', 'kts', 'scala', 'swift',
  'cs', 'fs', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'ml', 'zig', 'dart', 'sh', 'bash',
  'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'tf', 'tfvars',
  'hcl', 'gitignore', 'gitattributes', 'editorconfig', 'dockerignore', 'lock',
]);

const TEXT_BASENAMES = new Set([
  'readme', 'license', 'licence', 'copying', 'notice', 'authors', 'changelog', 'makefile',
  'dockerfile', 'jenkinsfile', 'procfile', 'vagrantfile', 'rakefile', 'gemfile', 'todo',
  'install', 'news', 'contributing', 'codeowners',
]);

const BINARY_EXTENSIONS = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'tar', '7z', 'rar', 'jar', 'war', 'exe', 'dll', 'so',
  'dylib', 'bin', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'db', 'sqlite',
  'sqlite3', 'mdb', 'dat', 'idx', 'pack', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  'ods', 'odp', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv',
  'flv', 'm4v', 'iso', 'img', 'dmg', 'deb', 'rpm', 'apk',
]);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'wave', 'aiff', 'aif', 'wma',
  'weba', 'spx',
]);
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdtext']);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', avif: 'image/avif', bmp: 'image/bmp',
  css: 'text/css', flac: 'audio/flac', gif: 'image/gif', htm: 'text/html', html: 'text/html',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', js: 'text/javascript', json: 'application/json',
  m4a: 'audio/mp4', m4b: 'audio/mp4', md: 'text/markdown', markdown: 'text/markdown', mp3: 'audio/mpeg',
  oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg', pdf: 'application/pdf', png: 'image/png',
  svg: 'image/svg+xml', txt: 'text/plain', wav: 'audio/wav', wave: 'audio/wav', weba: 'audio/webm',
  webp: 'image/webp', xhtml: 'application/xhtml+xml', xml: 'application/xml', yaml: 'application/yaml',
  yml: 'application/yaml',
};

/** Filename extension, excluding leading-dot files and trailing dots. */
export function extensionOfRemotePath(path: string): string | null {
  const basename = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return null;
  return basename.slice(dot + 1).toLowerCase();
}

/** Markdown suffix policy used by the Files view's source/render switch. */
export function isMarkdownRemotePath(path: string): boolean {
  const extension = extensionOfRemotePath(path);
  return extension != null && MARKDOWN_EXTENSIONS.has(extension);
}

/**
 * Classify from the basename only. An unrecognized suffix remains `unknown`
 * so callers can inspect a bounded byte prefix before offering a text editor.
 */
export function classifyFileByName(path: string): FileClassification {
  const basename = (path.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase();
  const extension = extensionOfRemotePath(path);
  if (extension == null) {
    if (basename.startsWith('.') && basename.length > 1 || TEXT_BASENAMES.has(basename)) {
      return { kind: 'text', mime: 'text/plain' };
    }
    return { kind: 'unknown', mime: null };
  }

  const mime = MIME_BY_EXTENSION[extension] ?? null;
  if (extension === 'pdf') return { kind: 'pdf', mime: mime ?? 'application/pdf' };
  if (HTML_EXTENSIONS.has(extension)) return { kind: 'html', mime: mime ?? 'text/html' };
  if (extension === 'svg') return { kind: 'svg', mime: mime ?? 'image/svg+xml' };
  if (MARKDOWN_EXTENSIONS.has(extension)) return { kind: 'markdown', mime: mime ?? 'text/markdown' };
  if (AUDIO_EXTENSIONS.has(extension)) return { kind: 'audio', mime: mime ?? 'audio/mpeg' };
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', mime: mime ?? 'image/png' };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', mime: mime ?? 'text/plain' };
  if (BINARY_EXTENSIONS.has(extension)) return { kind: 'binary', mime };
  return { kind: 'unknown', mime };
}

/** Whether the selected presentation has an editable source buffer. */
export function isEditableFileKind(kind: FileKind | null): boolean {
  return kind === 'text' || kind === 'html' || kind === 'markdown' || kind === 'svg';
}

/** Whether a file kind offers a rendered-document presentation. */
export function hasFilePreview(kind: FileKind | null): boolean {
  return kind === 'html' || kind === 'markdown' || kind === 'svg';
}

/** Classify common magic numbers without trusting the filename. */
export function classifyFileMagic(bytes: Uint8Array): FileClassification | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'image', mime: 'image/png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: 'image', mime: 'image/gif' };
  if (startsWith(bytes, [0x42, 0x4d])) return { kind: 'image', mime: 'image/bmp' };
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || startsWith(bytes, [0xff, 0xfb]) ||
      startsWith(bytes, [0xff, 0xf3]) || startsWith(bytes, [0xff, 0xf2])) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return { kind: 'audio', mime: 'audio/flac' };
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return { kind: 'audio', mime: 'audio/ogg' };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) {
    if (startsWithAt(bytes, 8, [0x57, 0x41, 0x56, 0x45])) return { kind: 'audio', mime: 'audio/wav' };
    if (startsWithAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return { kind: 'image', mime: 'image/webp' };
    return { kind: 'binary', mime: null };
  }
  if (startsWithAt(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    return brand.startsWith('M4A') || brand.startsWith('M4B')
      ? { kind: 'audio', mime: 'audio/mp4' }
      : { kind: 'binary', mime: null };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { kind: 'binary', mime: 'application/zip' };
  if (startsWith(bytes, [0x1f, 0x8b])) return { kind: 'binary', mime: 'application/gzip' };
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return { kind: 'binary', mime: 'application/x-elf' };
  return null;
}

/** Strict bounded UTF-8/printability sniff for filenames classified unknown. */
export function looksLikeRemoteText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.length === 0) return true;
  let wildControls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c && byte !== 0x08 && byte !== 0x1b) {
      wildControls += 1;
    }
  }
  if (wildControls / sample.length > 0.1) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Complete the name-based decision after a bounded read. A decisive suffix
 * remains authoritative; only `unknown` is refined by magic bytes or text
 * sniffing, matching the existing desktop Files policy.
 */
export function classifyFileBytes(named: FileClassification, bytes: Uint8Array): FileClassification {
  if (named.kind !== 'unknown') return named;
  const magic = classifyFileMagic(bytes);
  if (magic != null) return magic;
  return looksLikeRemoteText(bytes)
    ? { kind: 'text', mime: named.mime ?? 'text/plain' }
    : { kind: 'binary', mime: named.mime };
}

/** Directory-first, case-folded and locale-independent listing order. */
export function sortFileEntries<T extends Pick<DirEntry, 'name' | 'type'>>(
  entries: readonly T[],
): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      if (left.entry.type === 'dir' && right.entry.type !== 'dir') return -1;
      if (left.entry.type !== 'dir' && right.entry.type === 'dir') return 1;
      const leftFolded = left.entry.name.toLowerCase();
      const rightFolded = right.entry.name.toLowerCase();
      if (leftFolded < rightFolded) return -1;
      if (leftFolded > rightFolded) return 1;
      if (left.entry.name < right.entry.name) return -1;
      if (left.entry.name > right.entry.name) return 1;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

/**
 * Compare the metadata captured when text was loaded with a fresh SFTP stat.
 * Missing or incomplete metadata blocks a save; it is never treated as an
 * unchanged file.
 */
export function evaluateFileEditSave(
  loaded: RemoteFileMetadata | null | undefined,
  current: RemoteFileMetadata | null | undefined,
): FileEditSaveVerdict {
  if (current == null) return 'missing';
  if (!isVerifiableMetadata(loaded) || !isVerifiableMetadata(current)) return 'unverifiable';
  return loaded.isDirectory === current.isDirectory &&
      loaded.sizeBytes === current.sizeBytes &&
      loaded.modifiedEpochMs === current.modifiedEpochMs
    ? 'unchanged'
    : 'changed';
}

function isVerifiableMetadata(value: RemoteFileMetadata | null | undefined): value is RemoteFileMetadata {
  return value != null &&
    typeof value.isDirectory === 'boolean' &&
    Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0 &&
    Number.isFinite(value.modifiedEpochMs) && value.modifiedEpochMs > 0;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return startsWithAt(bytes, 0, signature);
}

function startsWithAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}
