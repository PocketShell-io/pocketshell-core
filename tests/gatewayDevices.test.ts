import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GATEWAY_MAX_DEVICES,
  GatewayDeviceListError,
  classifyGatewayDirectoryFailure,
  describeGatewayDeviceStatus,
  gatewayDeviceStatus,
  gatewayDevicesUrl,
  gatewayHostPinText,
  parseGatewayDeviceList,
  parseGatewayHostPin,
  pinMatchesAdvisory,
} from '../src/gatewayDevices';

// pocketshell#3086 slice 4: the gateway device list as every client reads it
// (pocketshell-gateway 8f2f360 internal/identity/service.go handleList) and
// the host-key pin a user pastes when adding a device (pocketshell-cli
// `gateway show --host-key`, `pocketshell-link show`, SHA256 fingerprints).

const KEYS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/gateway-host-keys.json', import.meta.url)), 'utf8'),
) as Record<string, { line: string; fingerprint: string }>;

const ED25519 = KEYS['ed25519']!;

function device(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'laptop-1',
    account_id: 'google:1234',
    public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ssh_host_key: ED25519.line,
    revoked: false,
    ...overrides,
  };
}

describe('gateway device list', () => {
  it('maps presence: online, offline, and an absent presence as unknown — never offline', () => {
    const devices = parseGatewayDeviceList({
      devices: [
        device({ id: 'on-1', presence: { online: true, observed_at: '2026-10-10T10:00:00.000Z', connected_since: '2026-10-10T09:00:00Z', session_generation: 3 } }),
        device({ id: 'off-1', presence: { online: false, observed_at: '2026-10-10T10:00:00.000Z' } }),
        device({ id: 'unknown-1' }),
      ],
    });
    expect(devices.map((d) => [d.id, d.presence.state])).toEqual([['on-1', 'online'], ['off-1', 'offline'], ['unknown-1', 'unknown']]);
    expect(devices[0]!.presence).toEqual({ state: 'online', observedAt: '2026-10-10T10:00:00.000Z', connectedSince: '2026-10-10T09:00:00Z' });
    expect(devices.map(gatewayDeviceStatus)).toEqual(['online', 'offline', 'unknown']);
  });

  it('a revoked device is marked revoked and is never online, even if presence said so', () => {
    const [revoked] = parseGatewayDeviceList({
      devices: [device({ id: 'gone-1', revoked: true, presence: { online: true, observed_at: '2026-10-10T10:00:00Z' } })],
    });
    expect(revoked!.revoked).toBe(true);
    expect(revoked!.presence.state).toBe('offline');
    expect(gatewayDeviceStatus(revoked!)).toBe('revoked');
    expect(describeGatewayDeviceStatus(revoked!)).toMatch(/^Revoked/);
  });

  it('keeps the advisory host key as a hint and drops the device identity key and account id', () => {
    const [row] = parseGatewayDeviceList({ devices: [device()] });
    expect(row).toEqual({ id: 'laptop-1', revoked: false, presence: { state: 'unknown' }, advisoryHostKey: ED25519.line });
    expect(JSON.stringify(row)).not.toContain('google:1234');
    expect(JSON.stringify(row)).not.toContain('public_key');
  });

  it('an empty account is an empty list', () => {
    expect(parseGatewayDeviceList({ devices: [] })).toEqual([]);
  });

  it('refuses anything that is not the documented shape rather than returning a partial list', () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { devices: {} },
      { devices: [device({ id: '../etc' })] },
      { devices: [device({ id: 'x' })] },
      { devices: [device({ revoked: 'false' })] },
      { devices: [device({ presence: { online: 'yes', observed_at: '2026-10-10T10:00:00Z' } })] },
      { devices: [device({ presence: { online: false } })] },
      { devices: [device({ presence: { online: false, observed_at: 'yesterday' } })] },
      { devices: [device({ presence: null })] },
      { devices: [device({ ssh_host_key: 42 })] },
      { devices: [device(), device()] },
      { devices: Array.from({ length: GATEWAY_MAX_DEVICES + 1 }, (_, i) => device({ id: `dev-${i}` })) },
    ];
    for (const body of bad) expect(() => parseGatewayDeviceList(body), JSON.stringify(body)?.slice(0, 80)).toThrow(GatewayDeviceListError);
  });

  it('describes presence from the gateway observation time, never from a probe', () => {
    const [off] = parseGatewayDeviceList({ devices: [device({ presence: { online: false, observed_at: '2026-10-10T10:00:00Z' } })] });
    expect(describeGatewayDeviceStatus(off!, Date.parse('2026-10-10T10:05:00Z'))).toBe('Offline (5 min ago)');
    const [unknown] = parseGatewayDeviceList({ devices: [device()] });
    expect(describeGatewayDeviceStatus(unknown!)).toBe('Status unknown');
  });

  it('derives the HTTPS device-list URL from a canonical gateway origin only', () => {
    expect(gatewayDevicesUrl('wss://gateway.pocketshell.io')).toBe('https://gateway.pocketshell.io/identity/v1/devices');
    expect(gatewayDevicesUrl('wss://localhost:3287/')).toBe('https://localhost:3287/identity/v1/devices');
    expect(gatewayDevicesUrl('wss://gateway.example/path')).toBeNull();
    expect(gatewayDevicesUrl('wss://gateway.example?token=x')).toBeNull();
  });
});

describe('pasted host-key pin', () => {
  it('accepts the `gateway show --host-key` line for every supported key type', () => {
    for (const name of ['ed25519', 'ecdsab256', 'ecdsab384', 'ecdsab521', 'rsab3072']) {
      const pin = parseGatewayHostPin(KEYS[name]!.line);
      expect(pin, name).not.toBeNull();
      expect(pin!.kind).toBe('host-key');
      expect(gatewayHostPinText(pin!)).toBe(KEYS[name]!.line);
    }
  });

  it('accepts the `pocketshell-link show` line and surrounding paste whitespace', () => {
    expect(parseGatewayHostPin(`pinned ssh host key: ${ED25519.line}`)).toEqual({
      kind: 'host-key',
      keyType: 'ssh-ed25519',
      keyB64: ED25519.line.split(' ')[1],
      line: ED25519.line,
    });
    expect(parseGatewayHostPin(`  ${ED25519.line}\n`)?.kind).toBe('host-key');
  });

  it('accepts a SHA256 fingerprint alone, from ssh-keygen -lf, or from the CLI note', () => {
    const fp = ED25519.fingerprint;
    for (const text of [fp, `256 ${fp} root@host (ED25519)`, `device laptop-1, host key ${fp} (ED25519).`, `sha256:${fp.slice(7)}=`]) {
      expect(parseGatewayHostPin(text), text).toEqual({ kind: 'fingerprint', fingerprint: fp });
    }
  });

  it('refuses bad input instead of repairing it', () => {
    const [type, b64] = ED25519.line.split(' ') as [string, string];
    const bad = [
      '',
      '   ',
      `${ED25519.line} root@host`, // a comment
      `${ED25519.line}\n${ED25519.line}`, // two lines
      `@cert-authority * ${ED25519.line}`,
      `ssh-dss ${b64}`, // unsupported type
      `ssh-rsa ${b64}`, // type does not match the blob
      `${type}  ${b64}`, // two spaces
      `${type} ${b64.slice(0, -4)}`, // truncated blob
      `${type} ${b64}=`, // non-canonical base64
      `${type} ${b64.replace(/[A-Z]/, '!')}`,
      KEYS['rsab1024']!.line, // RSA modulus below 2048 bits
      '-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAA SHA256:7AOMbhNlZOz/pEUTfQCxrsSKD+vxsnSMSUCZsHun1X0',
      'SHA256:tooshort',
      'MD5:aa:bb:cc',
      'not a key',
    ];
    for (const text of bad) expect(parseGatewayHostPin(text), JSON.stringify(text)).toBeNull();
  });

  it('compares a pasted key with the advisory one for information only', () => {
    const pin = parseGatewayHostPin(ED25519.line)!;
    expect(pinMatchesAdvisory(pin, ED25519.line)).toBe(true);
    expect(pinMatchesAdvisory(pin, KEYS['ecdsab256']!.line)).toBe(false);
    expect(pinMatchesAdvisory(pin, null)).toBeNull();
    expect(pinMatchesAdvisory(parseGatewayHostPin(ED25519.fingerprint)!, ED25519.line)).toBeNull();
  });
});

describe('device-list and pairing refusals', () => {
  const coded = (code: string, message = 'native message') => Object.assign(new Error(message), { code });

  it('sign-in, account change and an invalid pairing each get their own kind', () => {
    expect(classifyGatewayDirectoryFailure(coded('NOT_SIGNED_IN')).kind).toBe('sign_in_required');
    expect(classifyGatewayDirectoryFailure(coded('GATEWAY_BROKER_SIGN_IN_REJECTED')).kind).toBe('sign_in_required');
    expect(classifyGatewayDirectoryFailure(coded('GATEWAY_DEVICES_UNAUTHORIZED')).kind).toBe('sign_in_required');
    expect(classifyGatewayDirectoryFailure(coded('GATEWAY_ACCOUNT_CHANGED')).kind).toBe('account_changed');
    expect(classifyGatewayDirectoryFailure(coded('GATEWAY_PAIRING_ACCOUNT_CHANGED')).kind).toBe('account_changed');
    expect(classifyGatewayDirectoryFailure(coded('GATEWAY_PAIRING_INVALID', 'Enter the device id.'))).toEqual({
      kind: 'invalid_pairing',
      message: 'Enter the device id.',
    });
  });

  it('anything else is unavailable with its own message', () => {
    expect(classifyGatewayDirectoryFailure(coded('GATEWAY_DEVICES_UNREACHABLE', 'The gateway could not be reached.'))).toEqual({
      kind: 'unavailable',
      message: 'The gateway could not be reached.',
    });
    expect(classifyGatewayDirectoryFailure('boom').kind).toBe('unavailable');
  });
});
