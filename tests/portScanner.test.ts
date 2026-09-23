import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mergePortScanSections,
  parseNetstatTlnp,
  parsePortScanResult,
  parseProcCwds,
  parseProcessInfo,
  parseSsTln,
  parseSsTlnp,
  PORT_LISTENER_SCAN_COMMAND,
  procCwdCommand,
  splitSections,
} from '../src/portScanner.js';

const fixture = (name: string): string => readFileSync(
  new URL(`./fixtures/portscan/portscan-${name}.txt`, import.meta.url),
  'utf8',
);

function scanStdout(parts: {
  ssTln?: string;
  ssTlnp?: string;
  netstatTlnp?: string;
  netstatTln?: string;
}): string {
  return [
    '<<<PS_SS_TLN>>>', parts.ssTln ?? '',
    '<<<PS_SS_TLNP>>>', parts.ssTlnp ?? '',
    '<<<PS_NETSTAT_TLNP>>>', parts.netstatTlnp ?? '',
    '<<<PS_NETSTAT_TLN>>>', parts.netstatTln ?? '',
  ].join('\n');
}

describe('portable remote listener parser', () => {
  it('keeps the complete ss -tln list and enriches it with process attribution', () => {
    const ports = mergePortScanSections(scanStdout({
      ssTln: fixture('alpine-root-ss-tln'),
      ssTlnp: fixture('alpine-root-ss-tlnp'),
      netstatTlnp: fixture('alpine-root-netstat-tlnp'),
    }));
    expect(ports.map((port) => port.port)).toEqual([22, 3000, 4000, 4001, 5555, 8000, 9999, 19840, 43741]);
    expect(ports.find((port) => port.port === 8000)).toMatchObject({ process: 'python3', pid: 705 });
    expect(ports.find((port) => port.port === 4000)?.process).toBeNull();
  });

  it('falls back to BusyBox netstat and preserves truncated process names', () => {
    expect(mergePortScanSections(scanStdout({
      netstatTlnp: fixture('busybox-netstat-tlnp'),
      netstatTln: fixture('busybox-netstat-tln'),
    }))).toEqual([
      { port: 8081, process: 'nc', pid: 7, cwd: null },
      { port: 19840, process: 'nc', pid: 8, cwd: null },
    ]);
    expect(parseNetstatTlnp(fixture('nginx-root-netstat-tlnp'))[0]?.process).toBe('nginx');
  });

  it('parses ss/netstat attribution and rejects wildcard ports', () => {
    expect(parseProcessInfo('users:(("python3",pid=1527,fd=3),("python3",pid=1525,fd=3))'))
      .toEqual({ name: 'python3', pid: 1527 });
    expect(parseProcessInfo('1/sshd: /usr/sbin/s')).toEqual({ name: 'sshd', pid: 1 });
    expect(parseSsTln('LISTEN 0 128 *:* *:*')).toEqual([]);
    expect(parseSsTln(fixture('debian-root-ss-tln')).map((port) => port.port)).toEqual([8080, 19840]);
  });

  it('distinguishes failed, empty, and nonempty observations', () => {
    expect(parsePortScanResult('no sections', { exitCode: 0 })).toMatchObject({
      ok: false, error: 'port scan produced no output',
    });
    expect(parsePortScanResult('', { exitCode: null, stderr: 'lost connection' })).toMatchObject({
      ok: false, error: 'lost connection',
    });
    expect(parsePortScanResult('', { exitCode: 0, timedOut: true })).toMatchObject({
      ok: false, error: 'port scan timed out',
    });
    expect(parsePortScanResult(scanStdout({}), { exitCode: 0 })).toEqual({ ok: true, ports: [], error: null });
    expect(parsePortScanResult(scanStdout({ ssTln: fixture('debian-root-ss-tln') }), { exitCode: 0 }))
      .toMatchObject({ ok: true, ports: [{ port: 8080 }, { port: 19840 }] });
  });

  it('builds bounded cwd commands only from positive integer PIDs', () => {
    expect(procCwdCommand([705, Number.NaN, -5, 1.5, 703])).toContain('for pid in 705 703;');
    expect(procCwdCommand([])).toBe('');
    expect(parseProcCwds(fixture('alpine-nonroot-proc-cwd'))).toEqual(new Map([
      [1812, '/home/testuser/projects/client/web-api'],
      [1814, '/tmp/dir with spaces'],
      [707, '/home/testuser'],
      [709, '/tmp'],
    ]));
  });

  it('keeps the listener command to one SSH execution with all fallback sections', () => {
    expect(PORT_LISTENER_SCAN_COMMAND).toContain('ss -tln 2>/dev/null');
    expect(PORT_LISTENER_SCAN_COMMAND).toContain('ss -tlnp 2>/dev/null');
    expect(PORT_LISTENER_SCAN_COMMAND).toContain('netstat -tlnp 2>/dev/null');
    expect(PORT_LISTENER_SCAN_COMMAND.trimEnd().endsWith('true')).toBe(true);
    expect(Object.keys(splitSections(scanStdout({ ssTln: 'payload' })))).toHaveLength(4);
  });
});
