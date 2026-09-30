import { describe, expect, it } from 'vitest';
import {
  ANDROID_RELEASES_API,
  checkLatestRelease,
  formatPublishedDate,
  isNewerRelease,
  isTrustedReleaseUrl,
  parseLatestRelease,
  parseReleaseVersion,
  pickAndroidApkAsset,
  releaseHttpFailureReason,
  releaseVersionLabel,
  type ReleaseFetch,
} from '../src';

const debugApk = (assets: readonly { name: string; downloadUrl: string }[]) => pickAndroidApkAsset(assets, false);

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/PocketShell-io/pocketshell/releases/tag/${tag}`,
    published_at: '2026-09-03T10:15:00Z',
    assets: [
      { name: `pocketshell-${tag}-release.apk`, browser_download_url: `https://github.com/PocketShell-io/pocketshell/releases/download/${tag}/pocketshell-${tag}-release.apk` },
      { name: `pocketshell-${tag}-debug.apk`, browser_download_url: `https://github.com/PocketShell-io/pocketshell/releases/download/${tag}/pocketshell-${tag}-debug.apk` },
    ],
    ...extra,
  };
}

function fetcherFor(response: { ok: boolean; status: number; body?: unknown; throws?: Error }): ReleaseFetch & { urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    if (response.throws) throw response.throws;
    return { ok: response.ok, status: response.status, json: async () => response.body };
  }) as ReleaseFetch & { urls: string[] };
  fetcher.urls = urls;
  return fetcher;
}

describe('release check policy', () => {
  it('compares dotted versions numerically and ignores pre-release or describe suffixes', () => {
    expect(parseReleaseVersion('v0.5.3')).toEqual({ major: 0, minor: 5, patch: 3 });
    expect(parseReleaseVersion('0.6.0-dev')).toEqual({ major: 0, minor: 6, patch: 0 });
    expect(parseReleaseVersion('0.5.5-12-gabc1234')).toEqual({ major: 0, minor: 5, patch: 5 });
    expect(parseReleaseVersion('nightly')).toBeNull();
    expect(isNewerRelease('v0.5.10', '0.5.9')).toBe(true);
    expect(isNewerRelease('v1.0.0', '0.99.99')).toBe(true);
    expect(isNewerRelease('v0.6.0', '0.6.0-dev')).toBe(false);
    expect(isNewerRelease('v0.5.3', '0.5.3')).toBe(false);
    expect(isNewerRelease('v0.5.2', '0.5.3')).toBe(false);
    expect(isNewerRelease('garbage', '0.5.3')).toBe(false);
    expect(isNewerRelease('v0.5.4', 'unknown')).toBe(false);
    expect(releaseVersionLabel('0.5.5-12-gabc1234')).toBe('v0.5.5');
  });

  it('picks the APK for the install flavour and falls back to the first APK', () => {
    const assets = release('v0.5.6').assets.map((asset) => ({ name: asset.name, downloadUrl: asset.browser_download_url }));
    expect(pickAndroidApkAsset(assets, true)).toContain('-release.apk');
    expect(pickAndroidApkAsset(assets, false)).toContain('-debug.apk');
    expect(pickAndroidApkAsset([{ name: 'other.apk', downloadUrl: 'https://github.com/x/other.apk' }], true)).toBe('https://github.com/x/other.apk');
    expect(pickAndroidApkAsset([{ name: 'notes.txt', downloadUrl: 'https://github.com/x/notes.txt' }], true)).toBeNull();
  });

  it('answers available, up-to-date and failed as distinct results', () => {
    const available = parseLatestRelease(release('v0.5.6'), '0.5.5', debugApk);
    expect(available).toMatchObject({
      status: 'available',
      currentVersion: '0.5.5',
      tagName: 'v0.5.6',
      notesUrl: 'https://github.com/PocketShell-io/pocketshell/releases/tag/v0.5.6',
      publishedAt: '2026-09-03T10:15:00Z',
    });
    expect(available.status === 'available' && available.downloadUrl).toContain('-debug.apk');
    expect(parseLatestRelease(release('v0.5.5'), '0.5.5', debugApk)).toEqual({ status: 'up-to-date', currentVersion: '0.5.5' });
    expect(parseLatestRelease(null, '0.5.5', debugApk)).toMatchObject({ status: 'failed' });
    expect(parseLatestRelease({ tag_name: '' }, '0.5.5', debugApk)).toMatchObject({ status: 'failed', reason: 'latest release has no tag' });
    expect(parseLatestRelease(release('v0.5.6'), 'unknown', debugApk)).toMatchObject({ status: 'failed', reason: 'installed version is unknown' });
    expect(parseLatestRelease(release('v0.5.6', { assets: [] }), '0.5.5', debugApk)).toMatchObject({ status: 'failed' });
  });

  it('never hands a non-GitHub or non-HTTPS link to the platform browser', () => {
    expect(isTrustedReleaseUrl('https://github.com/PocketShell-io/pocketshell/releases/tag/v1')).toBe(true);
    expect(isTrustedReleaseUrl('http://github.com/x')).toBe(false);
    expect(isTrustedReleaseUrl('https://github.com.evil.example/x')).toBe(false);
    expect(isTrustedReleaseUrl('javascript:alert(1)')).toBe(false);
    const hostile = release('v0.5.6', { html_url: 'https://evil.example/notes' });
    expect(parseLatestRelease(hostile, '0.5.5', debugApk)).toMatchObject({ status: 'failed' });
    const hostileAsset = release('v0.5.6', { assets: [{ name: 'pocketshell-debug.apk', browser_download_url: 'https://evil.example/a.apk' }] });
    expect(parseLatestRelease(hostileAsset, '0.5.5', debugApk)).toMatchObject({ status: 'failed' });
  });

  it('polls the injected endpoint and turns HTTP, parse and network failures into reasons', async () => {
    const ok = fetcherFor({ ok: true, status: 200, body: release('v0.5.6') });
    await expect(checkLatestRelease({ currentVersion: '0.5.5', pickAsset: debugApk, fetcher: ok })).resolves.toMatchObject({ status: 'available' });
    expect(ok.urls).toEqual([ANDROID_RELEASES_API]);

    const limited = fetcherFor({ ok: false, status: 403 });
    await expect(checkLatestRelease({ currentVersion: '0.5.5', pickAsset: debugApk, fetcher: limited }))
      .resolves.toEqual({ status: 'failed', reason: 'rate-limited, try again later', currentVersion: '0.5.5' });
    expect(releaseHttpFailureReason(502)).toBe('server error (HTTP 502)');

    const offline = fetcherFor({ ok: true, status: 200, throws: new TypeError('Failed to fetch') });
    await expect(checkLatestRelease({ currentVersion: '0.5.5', pickAsset: debugApk, fetcher: offline }))
      .resolves.toMatchObject({ status: 'failed', reason: 'no network connection' });

    const hung: ReleaseFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    await expect(checkLatestRelease({ currentVersion: '0.5.5', pickAsset: debugApk, fetcher: hung, timeoutMs: 5 }))
      .resolves.toMatchObject({ status: 'failed', reason: 'timed out' });
  });

  it('formats a published date without a clock time', () => {
    expect(formatPublishedDate('2026-09-03T10:15:00Z', 'en-GB')).toBe('3 Sept 2026');
    expect(formatPublishedDate('not a date')).toBe('');
    expect(formatPublishedDate(undefined)).toBe('');
  });
});
