/**
 * Pure POSIX path rules for remote SFTP paths.
 *
 * Remote paths always use `/`, regardless of the client OS. These functions
 * normalize lexical paths only; they cannot see remote symlinks. A caller
 * enforcing a filesystem boundary must also resolve the path on the host and
 * check the resolved result before reading or writing.
 */

export type RemoteChildPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'empty-name' | 'dot-segment' | 'separator' | 'nul' | 'invalid-directory' };

/**
 * Normalize an absolute or relative remote path into an absolute POSIX path.
 * Repeated separators and `.` are folded; `..` moves toward `/` and clamps at
 * the root, matching `cd /..`. NUL is rejected because native path APIs may
 * interpret it as a terminator.
 */
export function normalizeRemotePath(path: string): string | null {
  if (path.includes('\0')) return null;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/** True when a path uses the host's login-home shorthand. */
export function isHomeRelativeRemotePath(path: string): boolean {
  return path === '~' || path.startsWith('~/') || path === '$HOME' || path.startsWith('$HOME/');
}

/**
 * Expand `~`, `~/...`, `$HOME`, or `$HOME/...` using the known remote home.
 * Returns null when a home-relative path cannot honestly be resolved.
 */
export function expandRemoteHome(path: string, home?: string | null): string | null {
  if (path.includes('\0')) return null;
  if (!isHomeRelativeRemotePath(path)) return path;
  const normalizedHome = home == null || home.trim() === '' ? null : normalizeRemotePath(home.trim());
  if (normalizedHome == null) return null;

  if (path === '~' || path === '$HOME') return normalizedHome;
  const tail = path.startsWith('~/') ? path.slice(2) : path.slice('$HOME/'.length);
  return normalizeRemotePath(`${normalizedHome}/${tail}`);
}

/**
 * Resolve a typed or discovered remote path against a directory.
 * Absolute paths ignore `base`; home-relative paths require `home`; other
 * relative paths use `base`, defaulting to the remote root.
 */
export function resolveRemotePath(
  path: string,
  base?: string | null,
  home?: string | null,
): string | null {
  if (path.includes('\0')) return null;
  const expanded = expandRemoteHome(path, home);
  if (expanded == null) return null;
  if (expanded.startsWith('/')) return normalizeRemotePath(expanded);

  // `~other` is another user's home, not a relative path under this user's
  // home. Treating it as the latter could navigate to the wrong file.
  if (expanded.startsWith('~')) return null;

  const expandedBase = base == null || base === '' ? '/' : expandRemoteHome(base, home);
  if (expandedBase == null) return null;
  const normalizedBase = normalizeRemotePath(expandedBase);
  if (normalizedBase == null) return null;
  return normalizeRemotePath(`${normalizedBase}/${expanded}`);
}

/**
 * Resolve one entry name under a directory without allowing it to become a
 * path. Backslash remains an ordinary POSIX filename character.
 */
export function joinRemoteChildPath(directory: string, name: string): RemoteChildPathResult {
  if (name.includes('\0')) return { ok: false, reason: 'nul' };
  if (name === '') return { ok: false, reason: 'empty-name' };
  if (name === '.' || name === '..') return { ok: false, reason: 'dot-segment' };
  if (name.includes('/')) return { ok: false, reason: 'separator' };
  const base = normalizeRemotePath(directory);
  if (base == null) return { ok: false, reason: 'invalid-directory' };
  return { ok: true, path: base === '/' ? `/${name}` : `${base}/${name}` };
}

/** The parent directory of a normalized remote path; `/` is its own parent. */
export function parentRemotePath(path: string): string | null {
  const normalized = normalizeRemotePath(path);
  if (normalized == null || normalized === '/') return normalized;
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : normalized.slice(0, lastSlash);
}

/** The final path component, or `/` for the root. */
export function remotePathName(path: string): string | null {
  const normalized = normalizeRemotePath(path);
  if (normalized == null || normalized === '/') return normalized;
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * Lexical containment check for normalized paths. This does not account for
 * symlinks; use remote `realpath` and check its result for security-sensitive
 * reads or writes.
 */
export function isRemotePathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedCandidate = normalizeRemotePath(candidate);
  if (normalizedRoot == null || normalizedCandidate == null) return false;
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedRoot === '/'
    ? normalizedCandidate.startsWith('/')
    : normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
