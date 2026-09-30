import type { UpdateCheckResult } from './types';

/**
 * Release check policy — one GitHub `releases/latest` poll compared against
 * the installed version, the JS port of 0.5.x Android `ReleaseChecker.kt` and
 * the shape of desktop's `main/update/ReleaseChecker.ts`.
 *
 * Pure policy: no DOM, Vue, Capacitor or network import. The platform passes a
 * `fetch`-shaped function and an asset picker, and the answer is the three-way
 * `UpdateCheckResult` so it plugs into the shared UI's `api.update.check()`
 * seam unchanged. `up-to-date` and `failed` stay distinct answers (#515): a
 * network blip must never read as "current".
 *
 * Like 0.5.x and desktop, PocketShell never installs anything itself. An
 * available result carries a download URL and the release page; opening them
 * is a user action handed to the system browser.
 */

/** The Android app's release feed (the PocketShell repository). */
export const ANDROID_RELEASES_API = 'https://api.github.com/repos/PocketShell-io/pocketshell/releases/latest';
export const RELEASE_CHECK_TIMEOUT_MS = 10_000;

export type ReleaseCheckResult = UpdateCheckResult & { publishedAt?: string };

/** Chooses the downloadable asset for this platform, or null when the release has none. */
export type ReleaseAssetPicker = (assets: readonly { name: string; downloadUrl: string }[]) => string | null;

export type ReleaseFetch = (
  input: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/;

/**
 * Parse `v0.5.3`, `0.5.3`, `0.6.0-dev` or `0.5.3-4-gabc123` into its numeric
 * release. A pre-release/build suffix is ignored, matching 0.5.x: an installed
 * `0.6.0-dev` build is not offered `v0.6.0` as an "update" of itself.
 */
export function parseReleaseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(raw.trim());
  if (!match) return null;
  const parts = [match[1], match[2] ?? '0', match[3] ?? '0'].map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  const [major, minor, patch] = parts as [number, number, number];
  return { major, minor, patch };
}

/** True only when [tag] is strictly newer than [current]; an unreadable side is never an update. */
export function isNewerRelease(tag: string, current: string): boolean {
  const remote = parseReleaseVersion(tag);
  const installed = parseReleaseVersion(current);
  if (!remote || !installed) return false;
  if (remote.major !== installed.major) return remote.major > installed.major;
  if (remote.minor !== installed.minor) return remote.minor > installed.minor;
  return remote.patch > installed.patch;
}

/** `v0.5.3` for display; an unparseable name is shown trimmed rather than invented. */
export function releaseVersionLabel(versionName: string): string {
  const parsed = parseReleaseVersion(versionName);
  return parsed ? `v${parsed.major}.${parsed.minor}.${parsed.patch}` : versionName.trim().replace(/^v/i, '') || 'unknown';
}

/**
 * Pick the APK for this build flavour: a `pocketshell…-debug.apk` for a debug
 * install, `…-release.apk` for a release install, else the first APK.
 */
export function pickAndroidApkAsset(
  assets: readonly { name: string; downloadUrl: string }[],
  preferRelease: boolean,
): string | null {
  let firstApk: string | null = null;
  for (const asset of assets) {
    const name = asset.name.toLowerCase();
    if (!name.endsWith('.apk') || !asset.downloadUrl) continue;
    const variant = preferRelease ? name.includes('-release.apk') : name.includes('-debug.apk');
    if (variant && name.includes('pocketshell')) return asset.downloadUrl;
    firstApk ??= asset.downloadUrl;
  }
  return firstApk;
}

/** Only GitHub HTTPS release links may be handed to the system browser. */
export function isTrustedReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'github.com' || parsed.hostname === 'objects.githubusercontent.com'
        || parsed.hostname === 'release-assets.githubusercontent.com');
  } catch {
    return false;
  }
}

/** Map one `releases/latest` payload to the three-way result. Never throws. */
export function parseLatestRelease(
  body: unknown,
  currentVersion: string,
  pickAsset: ReleaseAssetPicker,
): ReleaseCheckResult {
  if (typeof body !== 'object' || body === null) {
    return { status: 'failed', reason: 'unreadable release response', currentVersion };
  }
  const doc = body as Record<string, unknown>;
  const tagName = typeof doc.tag_name === 'string' ? doc.tag_name.trim() : '';
  if (!tagName) return { status: 'failed', reason: 'latest release has no tag', currentVersion };
  if (!parseReleaseVersion(tagName)) {
    return { status: 'failed', reason: `latest release tag is not a version: ${tagName.slice(0, 40)}`, currentVersion };
  }
  if (!parseReleaseVersion(currentVersion)) {
    return { status: 'failed', reason: 'installed version is unknown', currentVersion };
  }
  if (!isNewerRelease(tagName, currentVersion)) return { status: 'up-to-date', currentVersion };

  const notesUrl = typeof doc.html_url === 'string' ? doc.html_url : '';
  if (!isTrustedReleaseUrl(notesUrl)) {
    return { status: 'failed', reason: `release ${tagName} has no release page`, currentVersion };
  }
  const assets = (Array.isArray(doc.assets) ? doc.assets : []).flatMap((asset: unknown) => {
    if (typeof asset !== 'object' || asset === null) return [];
    const record = asset as Record<string, unknown>;
    return typeof record.name === 'string' && typeof record.browser_download_url === 'string'
      ? [{ name: record.name, downloadUrl: record.browser_download_url }]
      : [];
  });
  const downloadUrl = pickAsset(assets);
  if (!downloadUrl || !isTrustedReleaseUrl(downloadUrl)) {
    return { status: 'failed', reason: `release ${tagName} has no download for this platform`, currentVersion };
  }
  const publishedAt = typeof doc.published_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(doc.published_at)
    ? doc.published_at
    : undefined;
  return {
    status: 'available',
    currentVersion,
    tagName,
    downloadUrl,
    notesUrl,
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/** 0.5.x wording for HTTP failures: 403 is GitHub's unauthenticated rate limit. */
export function releaseHttpFailureReason(status: number): string {
  return status === 403 ? 'rate-limited, try again later' : `server error (HTTP ${status})`;
}

/** One GitHub `releases/latest` poll. Every failure mode is a `failed` answer with a reason. */
export async function checkLatestRelease(input: {
  currentVersion: string;
  pickAsset: ReleaseAssetPicker;
  fetcher: ReleaseFetch;
  endpoint?: string;
  timeoutMs?: number;
}): Promise<ReleaseCheckResult> {
  const { currentVersion, pickAsset, fetcher } = input;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), input.timeoutMs ?? RELEASE_CHECK_TIMEOUT_MS) : null;
  try {
    const response = await fetcher(input.endpoint ?? ANDROID_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return { status: 'failed', reason: releaseHttpFailureReason(response.status), currentVersion };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'failed', reason: 'unreadable release response', currentVersion };
    }
    return parseLatestRelease(body, currentVersion, pickAsset);
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { status: 'failed', reason: aborted ? 'timed out' : 'no network connection', currentVersion };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `3 Sep 2026` for a GitHub `published_at`; never a clock time. */
export function formatPublishedDate(publishedAt: string | undefined, locale = 'en-GB'): string {
  if (!publishedAt) return '';
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}
