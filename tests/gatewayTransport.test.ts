import { describe, expect, it } from 'vitest';
import {
  GATEWAY_CLOSED_ERROR_CODE,
  GATEWAY_DEFAULT_SERVER_URL,
  GATEWAY_SSH_PATH_PREFIX,
  buildGatewayAuthFrame,
  classifyGatewayClose,
  classifyGatewayDialFailure,
  gatewaySshUrl,
  hostKeyLineBlobB64,
  isValidGatewayDeviceId,
  normalizeGatewayServerUrl,
  normalizeGatewayTarget,
  normalizeSha256Fingerprint,
  parseGatewayHandshakeFrame,
  sameHostKeyBlobB64,
  verifyGatewayHostKeyPin,
} from '../src/gatewayTransport';
import { parseSyncPayload, serializeSyncPayload } from '../src/syncMerge';
import type { HostEntry } from '../src/types';

// The gateway transport contract: URL/target validation, handshake frames,
// close codes, fingerprints, and the fail-closed host-key verdict. The wire
// shapes mirror pocketshell-gateway-tunnel/internal/tunnel (protocol.go,
// service.go, identity.go).

describe('gateway target validation', () => {
  it('refuses original credential path and control placements before URL canonicalization', () => {
    for (const input of [ 'wss://secret@gateway.example', 'wss://gateway.example/secret/..',
      'wss://gate\tway.example', 'wss://gate\nway.example', 'wss://%67ateway.example',
      'wss://gateway.example?token=secret', 'wss://gateway.example#secret' ]) {
      expect(normalizeGatewayServerUrl(input)).toBeNull();
    }
  });

  it('the canonical production URL normalizes to itself', () => {
    expect(normalizeGatewayServerUrl('wss://gateway.pocketshell.io')).toBe(GATEWAY_DEFAULT_SERVER_URL);
    expect(normalizeGatewayServerUrl('wss://gateway.pocketshell.io/')).toBe(GATEWAY_DEFAULT_SERVER_URL);
  });

  it('an https:// spelling maps to wss://, http:// to ws://', () => {
    expect(normalizeGatewayServerUrl('https://gateway.pocketshell.io')).toBe(GATEWAY_DEFAULT_SERVER_URL);
    expect(normalizeGatewayServerUrl('http://localhost:8080')).toBe('ws://localhost:8080');
  });

  it('paths, queries and fragments are rejected — nothing smuggles a token into a URL', () => {
    expect(normalizeGatewayServerUrl('wss://gateway.pocketshell.io/api/v1/hosts/x/ssh?token=abc')).toBeNull();
    expect(normalizeGatewayServerUrl('wss://gateway.pocketshell.io/api')).toBeNull();
    expect(normalizeGatewayServerUrl('wss://gateway.pocketshell.io#x')).toBeNull();
  });

  it('non-socket schemes and junk are rejected', () => {
    expect(normalizeGatewayServerUrl('ftp://gateway.pocketshell.io')).toBeNull();
    expect(normalizeGatewayServerUrl('gateway.pocketshell.io')).toBeNull();
    expect(normalizeGatewayServerUrl('')).toBeNull();
    expect(normalizeGatewayServerUrl('   ')).toBeNull();
  });

  it('device ids follow the registry pattern the Go side enforces', () => {
    expect(isValidGatewayDeviceId('dev-01')).toBe(true);
    expect(isValidGatewayDeviceId('a.b_c:d')).toBe(true);
    expect(isValidGatewayDeviceId('')).toBe(false);
    expect(isValidGatewayDeviceId('-lead')).toBe(false);
    expect(isValidGatewayDeviceId('ab')).toBe(false); // shorter than the minimum
    expect(isValidGatewayDeviceId('has space')).toBe(false);
    expect(isValidGatewayDeviceId('../etc')).toBe(false);
    expect(isValidGatewayDeviceId('a'.repeat(64))).toBe(true); // 1 + 63 is the registry maximum
    expect(isValidGatewayDeviceId('a'.repeat(65))).toBe(false);
    expect(isValidGatewayDeviceId('a'.repeat(3))).toBe(true);
  });

  it('a raw target normalizes, or is null so the entry refuses to dial', () => {
    expect(normalizeGatewayTarget({ serverUrl: 'https://gateway.pocketshell.io', deviceId: ' dev-01 ' })).toEqual({
      serverUrl: GATEWAY_DEFAULT_SERVER_URL,
      deviceId: 'dev-01',
    });
    expect(normalizeGatewayTarget({ serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'nope space' })).toBeNull();
    expect(normalizeGatewayTarget({ serverUrl: 'wss://g/x', deviceId: 'dev-01' })).toBeNull();
    expect(normalizeGatewayTarget('wss://gateway.pocketshell.io')).toBeNull();
    expect(normalizeGatewayTarget(null)).toBeNull();
  });

  it('the dial URL is the per-host ssh route with the device id encoded, and never a query', () => {
    expect(gatewaySshUrl({ serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'dev-01' })).toBe(
      'wss://gateway.pocketshell.io/api/v1/hosts/dev-01/ssh',
    );
    const colon = gatewaySshUrl({ serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'a:b.c-d' });
    expect(colon.startsWith(`${GATEWAY_DEFAULT_SERVER_URL}${GATEWAY_SSH_PATH_PREFIX}`)).toBe(true);
    expect(colon.endsWith('/ssh')).toBe(true);
    expect(colon).not.toContain('?');
    expect(colon).not.toMatch(/token/i);
  });

  it('ws:// dials refuse without the explicit development flag and dial with it', () => {
    const dev = { serverUrl: 'ws://localhost:8080', deviceId: 'dev-01' };
    expect(() => gatewaySshUrl(dev)).toThrow(/allow-insecure/);
    expect(gatewaySshUrl(dev, { allowInsecureWs: true })).toBe('ws://localhost:8080/api/v1/hosts/dev-01/ssh');
  });

  it('a malformed target or device id throws a config error, never a dial', () => {
    expect(() => gatewaySshUrl({ serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'bad id' })).toThrow(/device id/);
    expect(() => gatewaySshUrl({ serverUrl: 'not a url', deviceId: 'dev-01' })).toThrow(/gateway URL/);
  });
});

describe('handshake frames', () => {
  it('the auth frame is the exact v1 JSON the gateway expects, token inside the frame only', () => {
    const frame = buildGatewayAuthFrame('tok.en-123', 'dev-01');
    expect(JSON.parse(frame)).toEqual({ type: 'auth', v: 1, token: 'tok.en-123', device_id: 'dev-01' });
    expect(frame).toBe('{"type":"auth","v":1,"token":"tok.en-123","device_id":"dev-01"}');
  });

  it('a ready frame parses strictly', () => {
    const text = '{"type":"ready","v":1,"device_id":"dev-01","ssh_host_key":"ssh-ed25519 AAAA"}';
    expect(parseGatewayHandshakeFrame(text)).toEqual({
      kind: 'ready',
      frame: { type: 'ready', v: 1, device_id: 'dev-01', ssh_host_key: 'ssh-ed25519 AAAA' },
    });
  });

  it('an error frame parses with its code and message', () => {
    const text = '{"type":"error","v":1,"code":"unauthorized","message":"token verification failed"}';
    const parsed = parseGatewayHandshakeFrame(text);
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.frame.code).toBe('unauthorized');
      expect(parsed.frame.message).toBe('token verification failed');
    }
  });

  it('malformed, wrong-version and unknown-type handshakes never parse into shape', () => {
    expect(parseGatewayHandshakeFrame('not json').kind).toBe('malformed');
    expect(parseGatewayHandshakeFrame('42').kind).toBe('malformed');
    expect(parseGatewayHandshakeFrame('{"type":"ready","v":2}').kind).toBe('malformed');
    expect(parseGatewayHandshakeFrame('{"type":"ready","v":1,"device_id":1,"ssh_host_key":"x"}').kind).toBe('malformed');
    expect(parseGatewayHandshakeFrame('{"type":"challenge","v":1}').kind).toBe('malformed');
    expect(parseGatewayHandshakeFrame('{"type":"error","v":1,"code":"x"}').kind).toBe('malformed');
  });
});

describe('close codes', () => {
  it('the application codes classify with user-appropriate copy', () => {
    expect(classifyGatewayClose(4401).kind).toBe('unauthorized');
    expect(classifyGatewayClose(4403).kind).toBe('forbidden');
    expect(classifyGatewayClose(4404).kind).toBe('not_found');
    expect(classifyGatewayClose(4408).kind).toBe('timeout');
    expect(classifyGatewayClose(4429).kind).toBe('quota');
    expect(classifyGatewayClose(4503).kind).toBe('host_offline');
    expect(classifyGatewayClose(4400).kind).toBe('protocol');
    expect(classifyGatewayClose(1006).kind).toBe('abnormal');
    expect(classifyGatewayClose(9999).kind).toBe('abnormal');
  });
});

describe('SHA-256 fingerprints', () => {
  const body = 'ABCDEFGHIJKLMNOPabcdefghijklmnop12345678901'; // 43 chars: 32 bytes unpadded

  it('a bare fingerprint normalizes to the OpenSSH display form', () => {
    expect(normalizeSha256Fingerprint(`SHA256:${body}`)).toBe(`SHA256:${body}`);
    expect(normalizeSha256Fingerprint(`sha256:${body}`)).toBe(`SHA256:${body}`);
    expect(normalizeSha256Fingerprint(`SHA256:${body}==`)).toBe(`SHA256:${body}`);
    expect(normalizeSha256Fingerprint(`  SHA256:${body}  `)).toBe(`SHA256:${body}`);
  });

  it('a full ssh-keygen -lf line yields its fingerprint', () => {
    expect(normalizeSha256Fingerprint(`256 SHA256:${body} dev-01 (ED25519)`)).toBe(`SHA256:${body}`);
  });

  it('md5 lines, hex, wrong lengths and non-base64 are refused', () => {
    expect(normalizeSha256Fingerprint('MD5:ab:cd:ef')).toBeNull();
    expect(normalizeSha256Fingerprint('deadbeef')).toBeNull();
    expect(normalizeSha256Fingerprint(`SHA256:${body.slice(0, 42)}`)).toBeNull();
    expect(normalizeSha256Fingerprint(`SHA256:${body}x`)).toBeNull(); // 44 chars: not a sha256 body
    expect(normalizeSha256Fingerprint('')).toBeNull();
  });
});

describe('the fail-closed host-key verdict', () => {
  const fp = (seed: number) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < 43; i++) out += alphabet[(i * seed + 7) % 64];
    return `SHA256:${out}`;
  };

  it('a matching pin trusts', () => {
    expect(verifyGatewayHostKeyPin(fp(1), fp(1))).toBe('trusted');
  });

  it('a different key mismatches', () => {
    expect(verifyGatewayHostKeyPin(fp(1), fp(2))).toBe('mismatch');
  });

  it('a missing, empty or malformed pin is UNPINNED — the dial refuses, no TOFU prompt exists', () => {
    expect(verifyGatewayHostKeyPin(undefined, fp(1))).toBe('unpinned');
    expect(verifyGatewayHostKeyPin(null, fp(1))).toBe('unpinned');
    expect(verifyGatewayHostKeyPin('', fp(1))).toBe('unpinned');
    expect(verifyGatewayHostKeyPin('MD5:ab:cd', fp(1))).toBe('unpinned');
  });

  it('the pin is accepted in any spelling the pairing flow could store', () => {
    const presented = fp(3);
    expect(verifyGatewayHostKeyPin(`sha256:${presented.slice(7)}=`, presented)).toBe('trusted');
  });
});

describe('advisory enrollment key line', () => {
  it('extracts the blob from two- and three-field OpenSSH lines', () => {
    expect(hostKeyLineBlobB64('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5')).toBe('AAAAC3NzaC1lZDI1NTE5');
    expect(hostKeyLineBlobB64('myhost,other ssh-ed25519 AAAAC3NzaC1lZDI1NTE5')).toBe('AAAAC3NzaC1lZDI1NTE5');
  });

  it('prose, single fields and non-base64 payloads are refused', () => {
    expect(hostKeyLineBlobB64('ssh-ed25519')).toBeNull();
    expect(hostKeyLineBlobB64('')).toBeNull();
    expect(hostKeyLineBlobB64('ssh-ed25519 not!!base64!!')).toBeNull();
    expect(hostKeyLineBlobB64('a b c d')).toBeNull();
  });

  it('blob equality ignores padding', () => {
    expect(sameHostKeyBlobB64('AAAA', 'AAAA')).toBe(true);
    expect(sameHostKeyBlobB64('AAAA=', 'AAAA')).toBe(true);
    expect(sameHostKeyBlobB64('AAAA', 'AAAB')).toBe(false);
  });
});

describe('the gateway field rides the sync payload', () => {
  const entry: HostEntry = {
    name: 'home-box',
    hostname: 'home-box',
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    gateway: { serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'dev-01' },
  };

  it('serialize → parse keeps the gateway target byte-identical', () => {
    const round = parseSyncPayload(serializeSyncPayload([entry]));
    expect(round).toHaveLength(1);
    expect(round[0]!.gateway).toEqual({ serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'dev-01' });
  });

  it('entries without the field parse unchanged, and a corrupt gateway value surfaces as-is for normalization', () => {
    const plain = { ...entry, gateway: undefined };
    expect(parseSyncPayload(serializeSyncPayload([plain as HostEntry]))[0]!.gateway).toBeUndefined();
    const junk = { ...entry, gateway: { serverUrl: 42 } };
    const parsed = parseSyncPayload(serializeSyncPayload([junk as unknown as HostEntry]))[0]!;
    expect(normalizeGatewayTarget(parsed.gateway)).toBeNull();
  });
});

describe('gateway dial failure matrix (pocketshell#3086)', () => {
  it('classifies the documented close codes with retry and advice', () => {
    const table = [
      [4400, 'protocol', false], [4401, 'unauthorized', false], [4403, 'forbidden', false], [4404, 'not_found', false],
      [4408, 'timeout', true], [4429, 'quota', true], [4503, 'host_offline', true],
    ] as const;
    for (const [closeCode, kind, retryable] of table) {
      expect(classifyGatewayDialFailure(GATEWAY_CLOSED_ERROR_CODE, { gatewayCloseCode: closeCode })).toEqual({
        closeCode, kind, retryable, userMessage: classifyGatewayClose(closeCode).userMessage,
      });
    }
  });

  it('returns null outside the matrix so the caller keeps its default', () => {
    for (const data of [{ gatewayCloseCode: 4000 }, { gatewayCloseCode: 1006 }, { gatewayCloseCode: '4401' },
      { gatewayCloseCode: 4401.5 }, {}]) {
      expect(classifyGatewayDialFailure(GATEWAY_CLOSED_ERROR_CODE, data)).toBeNull();
    }
    expect(classifyGatewayDialFailure('SSH_IO', { gatewayCloseCode: 4401 })).toBeNull();
  });
});
