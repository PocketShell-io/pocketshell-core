import { describe, expect, it } from 'vitest';
import {
  MAX_DIAGNOSTIC_REPORTS,
  formatDiagnosticReportsForSharing,
  legacyCrashReport,
  legacyDiagnosticHistoryReport,
  parseLegacyCrashReportTimestamp,
  redactCrashReport,
  redactDiagnosticText,
  runtimeErrorReport,
  sortDiagnosticReports,
  type DiagnosticReport,
} from '../src';

const LEGACY_REPORT = [
  'PocketShell crash report',
  'Generated: 2026-08-30T09:15:02.123Z',
  'App version: 0.5.4',
  'Android: 15 (SDK 35)',
  'Device: Pixel 8',
  'Thread: main',
  '',
  'Context',
  'Screen: Session',
  'Host: devbox',
  'Hostname: dev.example.internal',
  'User: alexey',
  'Session: secret-project',
  'Directory: /home/alexey/git/secret',
  'Exception summary: IllegalStateException: cannot attach alexey@dev.example.internal',
  'Top frame: com.pocketshell.next.Foo.bar(Foo.kt:12)',
  '',
  'Exception',
  'java.lang.IllegalStateException: password=hunter2 at /home/alexey/git/secret',
  '\tat com.pocketshell.next.Foo.bar(Foo.kt:12)',
].join('\n');

describe('local diagnostic reports', () => {
  it('redacts a 0.5.x crash report the way the Kotlin share path did', () => {
    const redacted = redactCrashReport(LEGACY_REPORT);
    for (const secret of ['devbox', 'dev.example.internal', 'alexey', 'secret-project', '/home/alexey', 'hunter2', 'Foo.kt:12)\nTop']) {
      expect(redacted, secret).not.toContain(secret);
    }
    expect(redacted).toContain('Host: [redacted]');
    expect(redacted).toContain('Exception summary: IllegalStateException\n');
    expect(redacted).toContain('Top frame: [redacted]');
    expect(redacted).toContain('password=[redacted]');
  });

  it('imports legacy crash reports and diagnostic history as dated, redacted reports', () => {
    const report = legacyCrashReport('legacy:1', 'crash-reports/20260830-091502-123.txt', LEGACY_REPORT);
    expect(report).toMatchObject({ source: 'imported-crash', at: Date.parse('2026-08-30T09:15:02.123Z'), title: '0.5.x crash report: IllegalStateException' });
    expect(report.body).not.toContain('dev.example.internal');
    expect(parseLegacyCrashReportTimestamp('20260830-091502-123.txt')).toBe(new Date(2026, 7, 30, 9, 15, 2, 123).getTime());
    expect(parseLegacyCrashReportTimestamp('notes.txt')).toBeNull();

    const history = legacyDiagnosticHistoryReport('legacy:h', [
      '{"category":"ssh","name":"connect_failed","wallClock":"2026-08-29T10:00:00Z","detail":"alexey@10.0.0.5"}',
      'not json',
      '{"category":"ui","name":"resume","wallClock":"2026-08-30T10:00:00Z"}',
    ].join('\n'));
    expect(history).toMatchObject({ source: 'imported-history', at: Date.parse('2026-08-30T10:00:00Z') });
    expect(history.body).toContain('Events: 2 (1 unreadable line omitted)');
    expect(history.body).not.toContain('10.0.0.5');
    expect(history.body).not.toContain('alexey@');
  });

  it('captures an uncaught runtime error by class, with a redacted message and stack', () => {
    const error = new TypeError('cannot read ssh://root@prod.example.com token: abc123');
    const report = runtimeErrorReport({ id: 'rt-1', at: 1_000, kind: 'unhandledrejection', error, appVersion: '0.6.0' });
    expect(report.title).toBe('Unhandled promise rejection: TypeError');
    expect(report.body).toContain('Exception summary: TypeError');
    expect(report.body).not.toContain('prod.example.com');
    expect(report.body).not.toContain('abc123');
    expect(runtimeErrorReport({ id: 'rt-2', at: 1, kind: 'error', error: 'plain' }).title).toBe('Uncaught error: Error');
    expect(redactDiagnosticText('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----')).toBe('<private-key-redacted>');
  });

  it('orders newest first, drops duplicate ids and bounds the list', () => {
    const make = (id: string, at: number | null): DiagnosticReport => ({ id, source: 'runtime-error', at, title: id, body: '' });
    expect(sortDiagnosticReports([make('a', 1), make('b', null), make('c', 3), make('a', 9)]).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    const many = Array.from({ length: MAX_DIAGNOSTIC_REPORTS + 5 }, (_, i) => make(`r${i}`, i));
    expect(sortDiagnosticReports(many)).toHaveLength(MAX_DIAGNOSTIC_REPORTS);
  });

  it('formats a share bundle that re-redacts every body', () => {
    const text = formatDiagnosticReportsForSharing([
      { id: 'x', source: 'native-crash', at: 0, title: 'Native crash: RuntimeException', body: 'at /home/alexey/app' },
    ], 0);
    expect(text).toContain('=== Native crash: RuntimeException');
    expect(text).toContain('Recorded: 1970-01-01T00:00:00.000Z');
    expect(text).not.toContain('/home/alexey');
  });

  describe('redacts seeded secrets (review 5920997338)', () => {
    const SEEDS = ['prodbox', 'SEEDEDPW123', 'SEEDEDTOK456', 'ghp_SEEDEDabcdef123456', 'MIIEvSEEDEDKEYBODY', 'secret-project', 'alexey', 'fe80::1ff:fe23:4567:890a', '2001:db8::8a2e:370:7334', '10.20.30.40', 'hunter2'];
    it.each([
      ['controller reconnect message', 'Could not reconnect to prodbox.corp.example.com after 5 attempts.'],
      ['controller session message', 'Session “secret-project” no longer exists on prodbox.corp.example.com.'],
      ['UnknownHost in a native crash', 'java.net.UnknownHostException: Unable to resolve host "prodbox.corp.example.com": No address associated with hostname'],
      ['UnknownHost with a single-label alias', 'java.net.UnknownHostException: Unable to resolve host "prodbox"'],
      ['ECONNREFUSED host:port', 'Error: connect ECONNREFUSED prodbox.corp.example.com:2222'],
      ['ENOTFOUND alias', 'getaddrinfo ENOTFOUND prodbox'],
      ['IPv6 literals', 'dial fe80::1ff:fe23:4567:890a%wlan0 and [2001:db8::8a2e:370:7334]:22 failed'],
      ['IPv4 with port', 'connect to 10.20.30.40:22 timed out'],
      ['JSON-keyed secrets', '{"password":"SEEDEDPW123","token":"SEEDEDTOK456","host":"prodbox.corp.example.com","user":"alexey"}'],
      ['key=value secrets', 'password=hunter2 passphrase: SEEDEDPW123 token SEEDEDTOK456'],
      ['PKCS#8 private key', '-----BEGIN PRIVATE KEY-----\nMIIEvSEEDEDKEYBODY\n-----END PRIVATE KEY-----'],
      ['encrypted PKCS#8 key', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIEvSEEDEDKEYBODY'],
      ['Authorization Bearer header', 'Authorization: Bearer ghp_SEEDEDabcdef123456'],
      ['bare bearer token', 'sent bearer SEEDEDTOK456abcdef to api'],
      ['GitHub token alone', 'token leaked: ghp_SEEDEDabcdef123456'],
      ['ssh URL with user', 'ssh://alexey@prodbox.corp.example.com:22/'],
      ['home path', 'open /home/alexey/secret-project/.env'],
    ])('%s', (_label, input) => {
      const out = redactDiagnosticText(input, { knownTerms: ['prodbox', 'alexey'] });
      for (const seed of SEEDS) expect(out, `${seed} survived in: ${out}`).not.toContain(seed);
    });

    it('keeps stack frames, file names, versions and times readable', () => {
      const benign = [
        '\tat com.pocketshell.app.SshCapabilityPlugin.connect(SshCapabilityPlugin.java:120)',
        'java.lang.IllegalStateException',
        'at connect (https://localhost/assets/index-abc123.js:1:2345)',
        'App version: 0.5.6-139-g3e004f29b',
        'Generated: 2026-09-30T21:24:49.156Z',
        'Android: 15 (SDK 35)',
      ];
      const out = benign.map((line) => redactDiagnosticText(line));
      expect(out[0]).toContain('com.pocketshell.app.SshCapabilityPlugin.connect(SshCapabilityPlugin.java:120)');
      expect(out[1]).toBe('java.lang.IllegalStateException');
      expect(out[2]).toContain('index-abc123.js:1:2345');
      expect(out[3]).toBe('App version: 0.5.6-139-g3e004f29b');
      expect(out[4]).toBe('Generated: 2026-09-30T21:24:49.156Z');
      expect(out[5]).toBe('Android: 15 (SDK 35)');
    });

    it('applies known host terms in every report builder and in the share bundle', () => {
      const terms = { knownTerms: ['devbox', 'alexey'] };
      const runtime = runtimeErrorReport({ id: 'r', at: 0, kind: 'error', error: new Error('lost devbox while alexey typed'), knownTerms: terms.knownTerms });
      const crash = legacyCrashReport('c', 'x.txt', 'Exception summary: IOException\n\nException\njava.io.IOException: devbox reset', terms);
      const history = legacyDiagnosticHistoryReport('h', '{"event":"lost devbox"}', terms);
      const bundle = formatDiagnosticReportsForSharing([{ id: 'x', source: 'native-crash', at: 0, title: 't', body: 'devbox' }], 0, terms);
      for (const text of [runtime.body, crash.body, history.body, bundle]) {
        expect(text).not.toContain('devbox');
        expect(text).not.toContain('alexey');
      }
    });
  });
});

