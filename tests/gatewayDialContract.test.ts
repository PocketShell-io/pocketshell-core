import { describe, expect, it } from 'vitest';
import {
  classifySshConnect,
  classifySshDial,
  gatewayHostKeyTrustNamespace,
  normalizeGatewayServerUrl,
  parseGatewayHandshakeFrame,
  type SshCapability,
  type SshConnectOptions,
  type SshConnectResult,
  type SshHostTarget,
} from '../src';
import { GATEWAY_DEFAULT_SERVER_URL } from '../src/gatewayTransport';
import { ConnectionController, type HostKeyTrustStore } from '../src/connectionController';
import type { HostKeyTrustPin } from '../src';

/**
 * The portable gateway-native dial contract: `SshHostTarget.gateway` is
 * intent, and `classifySshDial`/`classifySshConnect` are the strict,
 * effect-free boundary every platform must run before any dial effect. The
 * refusal arms here pin fail-closed behavior BEFORE effects — probes taken
 * verbatim from the independent source review (insecure-ws dial policy,
 * original-URL placement, credential and pin shapes); the healthy arms pin
 * that direct and link dials classify exactly as before and a gateway dial
 * normalizes into an accepted target. Every probe calls the actual
 * boundary/normalizer functions — none re-implements a predicate.
 */

function target(extra: Record<string, unknown> = {}): SshHostTarget {
  return {
    hostId: 'home-box',
    hostname: 'home-box.example',
    port: 22,
    username: 'alexey',
    credential: { kind: 'private-key', privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n' },
    ...extra,
  } as SshHostTarget;
}

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'dev-01' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };
const PIN = { kind: 'sha256-fingerprint' as const, fingerprintSha256: `SHA256:${'A'.repeat(43)}` };
/** A REAL ed25519 public key and its REAL SHA-256 fingerprint (the output
 * of `ssh-keygen -lf`) — healthy wire-key calibration, not a hand-waved
 * blob: the boundary must accept actual persisted pins and refuse toy ones. */
const REAL_HOST_KEY = {
  keyType: 'ssh-ed25519',
  keyB64: 'AAAAC3NzaC1lZDI1NTE5AAAAIGV5BsfERLiX1THWqwhu0MrnxaHBRqxmQJeLrqzIMBXr',
  fingerprintSha256: 'SHA256:5n2cXN3EJVqv+49z1L9jQHNMXOOKTirwbdskWxD7oeE',
} as const;
const REAL_FINGERPRINT_PIN = { kind: 'sha256-fingerprint' as const, fingerprintSha256: REAL_HOST_KEY.fingerprintSha256 };
const REAL_WIRE_KEY_PIN = { kind: 'wire-key' as const, ...REAL_HOST_KEY };

function connectOptions(extra: Record<string, unknown> = {}): SshConnectOptions {
  return {
    ...target({ gateway: VALID_GATEWAY }),
    requestId: 'req-1',
    generationId: 'gen-1',
    expectedHostKey: PIN,
    ...extra,
  } as SshConnectOptions;
}

function expectRefused(code: string, plan: ReturnType<typeof classifySshDial>): void {
  expect(plan.kind).toBe('refused');
  if (plan.kind !== 'refused') return;
  expect(plan.code).toBe(code);
  expect(typeof plan.message).toBe('string');
  expect(plan.message.length).toBeGreaterThan(0);
}

describe('malformed, null and undefined gateway markers refuse — never guess direct', () => {
  it('a null gateway marker is still gateway intent', () => {
    const t = target({ gateway: null }) as SshHostTarget;
    expectRefused('gateway-marker-invalid', classifySshDial(t));
  });

  it('an own undefined gateway marker is still gateway intent', () => {
    const t = target() as Record<string, unknown>;
    t['gateway'] = undefined;
    expectRefused('gateway-marker-invalid', classifySshDial(t as unknown as SshHostTarget));
  });

  it('a malformed gateway marker refuses on every unusable shape', () => {
    for (const marker of [{}, { deviceId: 'dev-01' }, { serverUrl: 'wss://gateway.example' }, { serverUrl: 42, deviceId: 'dev-01' }, 'wss://surprise']) {
      expectRefused('gateway-marker-invalid', classifySshDial(target({ gateway: marker as never })));
    }
  });

  it('a gateway URL with a path, query or fragment refuses at the boundary', () => {
    for (const serverUrl of [
      'wss://gateway.example/api/v1/hosts/dev-01/ssh',
      'wss://gateway.example/?token=abc',
      'wss://gateway.example#frag',
    ]) {
      expectRefused('gateway-marker-invalid', classifySshDial(target({ gateway: { serverUrl, deviceId: 'dev-01' } })));
    }
  });

  it('a registry-invalid device id refuses', () => {
    expectRefused('gateway-marker-invalid', classifySshDial(target({ gateway: { serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'bad id' } })));
  });

  it('refusals do not echo the offending marker back', () => {
    const plan = classifySshDial(target({ gateway: { serverUrl: 'wss://secret-url.example/leak', deviceId: 'device-with-secret' } }));
    if (plan.kind !== 'refused') throw new Error('expected refusal');
    expect(plan.message).not.toContain('secret-url');
    expect(plan.message).not.toContain('device-with-secret');
  });

  it('mirror refusals hold at the connect boundary too', () => {
    expectRefused('gateway-marker-invalid', classifySshConnect(connectOptions({ gateway: null })));
  });
});

describe('conflicting transports refuse', () => {
  it('both markers present, both valid', () => {
    expectRefused(
      'dial-transport-conflict',
      classifySshDial(target({ link: VALID_LINK, gateway: VALID_GATEWAY, credential: { kind: 'link-token', token: 't' } })),
    );
  });

  it('both markers present, both malformed', () => {
    const t = target({ credential: { kind: 'password', password: 'x' } }) as Record<string, unknown>;
    t['link'] = null;
    t['gateway'] = null;
    expectRefused('dial-transport-conflict', classifySshDial(t as unknown as SshHostTarget));
  });
});

describe('gateway credential rules', () => {
  it('a password credential never rides the gateway', () => {
    expectRefused(
      'gateway-credential-unsupported',
      classifySshDial(target({ gateway: VALID_GATEWAY, credential: { kind: 'password', password: 'x' } })),
    );
  });

  it('a link token is never a routing token', () => {
    expectRefused(
      'gateway-credential-unsupported',
      classifySshDial(target({ gateway: VALID_GATEWAY, credential: { kind: 'link-token', token: 'relay-secret' } })),
    );
  });

  it('a private-key credential with no key material refuses', () => {
    expectRefused(
      'credential-invalid',
      classifySshDial(target({ gateway: VALID_GATEWAY, credential: { kind: 'private-key', privateKeyPem: '   ' } })),
    );
  });

  it('an unusable key-handle credential refuses', () => {
    expectRefused(
      'credential-invalid',
      classifySshDial(target({ gateway: VALID_GATEWAY, credential: { kind: 'key-handle', handleId: '  ' } as never })),
    );
  });

  it('a missing credential refuses before any transport is picked', () => {
    expectRefused('credential-invalid', classifySshDial({ hostname: 'h', port: 22, username: 'u', hostId: 'h' } as SshHostTarget));
  });
});

describe('the independent host-key pin is mandatory at the gateway connect boundary', () => {
  it('a null pin refuses before effects', () => {
    expectRefused('gateway-host-key-unpinned', classifySshConnect(connectOptions({ expectedHostKey: null })));
  });

  it('an absent pin refuses', () => {
    const options = connectOptions();
    const missing = { ...options, expectedHostKey: undefined } as unknown as SshConnectOptions;
    expectRefused('gateway-host-key-unpinned', classifySshConnect(missing));
  });

  it('a pin whose fingerprint is not a usable SHA-256 refuses', () => {
    for (const fingerprint of ['', 'MD5:ab:cd:ef', 'SHA256:short']) {
      expectRefused(
        'gateway-host-key-unpinned',
        classifySshConnect(connectOptions({ expectedHostKey: { kind: 'sha256-fingerprint', fingerprintSha256: fingerprint } })),
      );
    }
  });

  it('the gateway-ready advisory can never substitute for the pin — the plan only carries the target', () => {
    const plan = classifySshConnect(connectOptions());
    expect(plan.kind).toBe('gateway');
    if (plan.kind !== 'gateway') return;
    expect(plan.gateway).toEqual(VALID_GATEWAY);
    expect(Object.keys(plan)).toEqual(['kind', 'gateway']);
  });
});

describe('healthy gateway dials normalize into an accepted target', () => {
  it('a private-key dial normalizes https and padded ids', () => {
    const plan = classifySshDial(target({ gateway: { serverUrl: 'https://gateway.pocketshell.io', deviceId: ' dev-01 ' } }));
    expect(plan).toEqual({ kind: 'gateway', gateway: { serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'dev-01' } });
  });

  it('a key-handle credential rides the gateway with its pin', () => {
    const plan = classifySshConnect(connectOptions({ credential: { kind: 'key-handle', handleId: 'vault-7' } }));
    expect(plan.kind).toBe('gateway');
  });

  it('an encrypted key (passphrase) is still a key credential', () => {
    const plan = classifySshDial(
      target({ gateway: VALID_GATEWAY, credential: { kind: 'private-key', privateKeyPem: '-----BEGIN\nk\n-----END\n', passphrase: 'opener' } }),
    );
    expect(plan.kind).toBe('gateway');
  });

  it('a wire-key pin carrying a REAL key and its REAL fingerprint satisfies the connect boundary', () => {
    expect(classifySshConnect(connectOptions({ expectedHostKey: REAL_WIRE_KEY_PIN })).kind).toBe('gateway');
    expect(classifySshConnect(connectOptions({ expectedHostKey: REAL_FINGERPRINT_PIN })).kind).toBe('gateway');
  });
});

describe('healthy direct and link dials classify exactly as before', () => {
  it('direct with each SSH credential kind', () => {
    expect(classifySshDial(target())).toEqual({ kind: 'direct' });
    expect(classifySshDial(target({ credential: { kind: 'password', password: 'x' } }))).toEqual({ kind: 'direct' });
    expect(classifySshDial(target({ credential: { kind: 'key-handle', handleId: 'h' } }))).toEqual({ kind: 'direct' });
  });

  it('link with the link target and link-token credential', () => {
    expect(
      classifySshDial(target({ link: VALID_LINK, credential: { kind: 'link-token', token: 'secret' } })),
    ).toEqual({ kind: 'link' });
  });

  it('the legacy misconfigurations the predicates passed through now refuse instead of falling back to direct', () => {
    expectRefused(
      'link-credential-mismatch',
      classifySshDial(target({ link: VALID_LINK, credential: { kind: 'password', password: 'x' } })),
    );
    expectRefused('link-token-without-link', classifySshDial(target({ credential: { kind: 'link-token', token: 'secret' } })));
  });

  it('a malformed link marker refuses instead of guessing direct', () => {
    const t = target() as Record<string, unknown>;
    t['link'] = null;
    expectRefused('link-marker-invalid', classifySshDial(t as unknown as SshHostTarget));
    expectRefused('link-marker-invalid', classifySshDial(target({ link: { relayUrl: '', hostId: 'x' } })));
  });

  it('an unknown credential shape refuses everywhere', () => {
    expectRefused('credential-invalid', classifySshDial(target({ credential: { kind: 'ticket' } as never })));
  });

  it('a non-object target refuses', () => {
    expectRefused('dial-target-invalid', classifySshDial(null as unknown as SshHostTarget));
    expectRefused('dial-target-invalid', classifySshDial('home-box' as unknown as SshHostTarget));
  });

  it('classification is pure: the same input classifies identically and the target is not mutated', () => {
    const t = target({ gateway: { serverUrl: 'https://gateway.pocketshell.io', deviceId: ' dev-01 ' } });
    const before = JSON.stringify(t);
    const one = classifySshDial(t);
    const two = classifySshDial(t);
    expect(one).toEqual(two);
    expect(JSON.stringify(t)).toBe(before);
    expect((t.gateway as { serverUrl: string }).serverUrl).toBe('https://gateway.pocketshell.io');
  });
});

describe('URL placements are explicit refusals, never silent drops', () => {
  it('misplaced user credentials in a gateway URL refuse instead of being stripped', () => {
    expect(normalizeGatewayServerUrl('wss://me:pass@gateway.pocketshell.io')).toBeNull();
    expect(normalizeGatewayServerUrl('wss://me@gateway.pocketshell.io')).toBeNull();
    expect(normalizeGatewayServerUrl('https://me:pass@gateway.pocketshell.io')).toBeNull();
    expect(normalizeGatewayServerUrl('wss://@gateway.pocketshell.io')).toBeNull();
    expect(
      classifySshDial(target({ gateway: { serverUrl: 'wss://me:pass@gateway.pocketshell.io', deviceId: 'dev-01' } })).kind,
    ).toBe('refused');
  });

  it('unsafe schemes never normalize into a target', () => {
    for (const serverUrl of ['javascript:alert(1)', 'data:text/plain,gateway', 'file:///etc/hosts', 'ftp://gateway.example']) {
      expect(normalizeGatewayServerUrl(serverUrl)).toBeNull();
    }
  });

  it('the clean origin still normalizes', () => {
    expect(normalizeGatewayServerUrl('wss://gateway.pocketshell.io')).toBe(GATEWAY_DEFAULT_SERVER_URL);
  });
});

describe('handshake diagnostics withhold peer field values', () => {
  it('malformed reasons name the fault without quoting peer type, version or payload', () => {
    for (const text of [
      '{"type":"challenge","v":9,"device_id":"dev-01","token":"sekret"}',
      '{"type":"ready","v":2,"secret":"hello"}',
      '{"type":"error","v":1,"code":"x"}',
      'not json at all',
    ]) {
      const parsed = parseGatewayHandshakeFrame(text);
      expect(parsed.kind).toBe('malformed');
      if (parsed.kind !== 'malformed') continue;
      expect(parsed.reason).not.toMatch(/challenge|sekret|hello|"v"|:9|v":2/);
    }
  });

  it('valid ready/error frames still parse for bounded platform state processing', () => {
    expect(parseGatewayHandshakeFrame('{"type":"ready","v":1,"device_id":"dev-01","ssh_host_key":"ssh-ed25519 AAAA"}').kind).toBe('ready');
    expect(parseGatewayHandshakeFrame('{"type":"error","v":1,"code":"unauthorized","message":"m"}').kind).toBe('error');
  });
});

describe('the gateway trust namespace keeps pairings from borrowing each other', () => {
  const target1 = { serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'dev-01' };

  it('the triple (account, origin, device) is the identity', () => {
    expect(gatewayHostKeyTrustNamespace('acct-1', target1)).toBe(gatewayHostKeyTrustNamespace('acct-1', target1));
    expect(gatewayHostKeyTrustNamespace('acct-2', target1)).not.toBe(gatewayHostKeyTrustNamespace('acct-1', target1));
    expect(gatewayHostKeyTrustNamespace('acct-1', { ...target1, deviceId: 'dev-02' })).not.toBe(
      gatewayHostKeyTrustNamespace('acct-1', target1),
    );
    expect(gatewayHostKeyTrustNamespace('acct-1', { ...target1, serverUrl: 'wss://other.example' })).not.toBe(
      gatewayHostKeyTrustNamespace('acct-1', target1),
    );
  });

  it('a field containing the separator cannot alias another triple', () => {
    const sneaky = gatewayHostKeyTrustNamespace('a","b', { serverUrl: 'wss://g', deviceId: 'd' });
    const honest = gatewayHostKeyTrustNamespace('a', { serverUrl: 'wss://g', deviceId: 'd' });
    expect(sneaky).not.toBe(honest);
    expect(sneaky.startsWith('gateway:')).toBe(true);
  });

  it('an empty account id is a config error', () => {
    expect(() => gatewayHostKeyTrustNamespace('  ', target1)).toThrow(/account/);
  });
});

describe('the dial boundary requires a secure gateway transport by default', () => {
  const insecureRemote = { serverUrl: 'ws://remote.example', deviceId: 'dev-01' };

  it('a ws:// gateway origin refuses without any policy setting', () => {
    expectRefused('gateway-transport-insecure', classifySshDial(target({ gateway: insecureRemote })));
  });

  it('an http:// origin, which normalizes to ws://, refuses the same way', () => {
    expectRefused(
      'gateway-transport-insecure',
      classifySshDial(target({ gateway: { serverUrl: 'http://remote.example', deviceId: 'dev-01' } })),
    );
  });

  it('the ws:// refusal holds at the connect boundary even with a healthy pin', () => {
    expectRefused('gateway-transport-insecure', classifySshConnect(connectOptions({ gateway: insecureRemote })));
  });

  it('an explicit trusted development policy admits a loopback ws:// gateway', () => {
    const policy = { allowInsecureLoopbackWs: true };
    for (const serverUrl of ['ws://localhost:8080', 'ws://127.0.0.1:3000', 'ws://[::1]:3000', 'ws://sub.localhost:8080']) {
      expect(classifySshDial(target({ gateway: { serverUrl, deviceId: 'dev-01' } }), policy)).toEqual({
        kind: 'gateway',
        gateway: { serverUrl, deviceId: 'dev-01' },
      });
    }
  });

  it('the development allowance is loopback-only: a remote ws:// refuses even with the flag', () => {
    expectRefused(
      'gateway-transport-insecure',
      classifySshDial(target({ gateway: insecureRemote }), { allowInsecureLoopbackWs: true }),
    );
  });

  it('without the policy even a loopback ws:// gateway refuses', () => {
    expectRefused(
      'gateway-transport-insecure',
      classifySshDial(target({ gateway: { serverUrl: 'ws://localhost:8080', deviceId: 'dev-01' } })),
    );
  });

  it('the saved marker can never widen its own transport policy', () => {
    expectRefused(
      'gateway-transport-insecure',
      classifySshDial(target({ gateway: { serverUrl: 'ws://remote.example', deviceId: 'dev-01', allowInsecureWs: true, development: true } as never })),
    );
    expectRefused(
      'gateway-transport-insecure',
      classifySshDial(target({ gateway: { serverUrl: 'ws://localhost:8080', deviceId: 'dev-01', allowInsecureWs: true } as never })),
    );
  });

  it('the policy changes nothing for secure wss dials and the plan carries only the normalized target', () => {
    const policy = { allowInsecureLoopbackWs: true };
    expect(classifySshDial(target({ gateway: VALID_GATEWAY }), policy)).toEqual({ kind: 'gateway', gateway: VALID_GATEWAY });
    const devPlan = classifySshDial(target({ gateway: { serverUrl: 'ws://localhost:8080', deviceId: 'dev-01' } }), policy);
    expect(devPlan).toEqual({ kind: 'gateway', gateway: { serverUrl: 'ws://localhost:8080', deviceId: 'dev-01' } });
  });
});

describe('the original URL placement is validated before canonicalization', () => {
  it('a dot-segment path never normalizes into a clean origin', () => {
    for (const serverUrl of [
      'wss://remote.example/secret/..',
      'wss://gateway.example/a/../b',
      'wss://gateway.example/.',
      'wss://gateway.example:443/x',
    ]) {
      expect(normalizeGatewayServerUrl(serverUrl)).toBeNull();
      expect(classifySshDial(target({ gateway: { serverUrl, deviceId: 'dev-01' } })).kind).toBe('refused');
    }
  });

  it('characters the URL parser would silently strip or encode refuse instead', () => {
    for (const serverUrl of ['wss://gate\tway.example', 'wss://gateway.example\u0000', 'wss://ga te.example']) {
      expect(normalizeGatewayServerUrl(serverUrl)).toBeNull();
    }
  });

  it('the legitimate canonicalizations still work', () => {
    expect(normalizeGatewayServerUrl('WSS://GATEWAY.EXAMPLE/')).toBe('wss://gateway.example');
    expect(normalizeGatewayServerUrl('wss://gateway.example:443')).toBe('wss://gateway.example');
    expect(normalizeGatewayServerUrl('ws://gateway.example:80')).toBe('ws://gateway.example');
    expect(normalizeGatewayServerUrl('wss://gateway.example/')).toBe('wss://gateway.example');
    expect(normalizeGatewayServerUrl('ws://localhost:8080')).toBe('ws://localhost:8080');
  });
});

describe('credential shapes are refused before any transport effect', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n';

  it('a non-string private-key passphrase refuses on the gateway arm', () => {
    for (const passphrase of [42, {}, [], true]) {
      expectRefused(
        'credential-invalid',
        classifySshDial(target({ gateway: VALID_GATEWAY, credential: { kind: 'private-key', privateKeyPem: key, passphrase } as never })),
      );
    }
  });

  it('a non-string private-key passphrase refuses on the direct arm too', () => {
    for (const passphrase of [42, {}, [], true]) {
      expectRefused(
        'credential-invalid',
        classifySshDial(target({ credential: { kind: 'private-key', privateKeyPem: key, passphrase } as never })),
      );
    }
  });

  it('absent, null and string passphrases stay healthy credentials', () => {
    expect(classifySshDial(target())).toEqual({ kind: 'direct' });
    expect(
      classifySshDial(target({ credential: { kind: 'private-key', privateKeyPem: key, passphrase: null } })),
    ).toEqual({ kind: 'direct' });
    expect(
      classifySshDial(target({ gateway: VALID_GATEWAY, credential: { kind: 'private-key', privateKeyPem: key, passphrase: 'opener' } })),
    ).toEqual({ kind: 'gateway', gateway: VALID_GATEWAY });
  });
});

describe('the connect-time pin must be a supported, canonical shape', () => {
  it('an unsupported pin kind refuses even with a well-formed fingerprint', () => {
    expectRefused(
      'gateway-host-key-unpinned',
      classifySshConnect(connectOptions({ expectedHostKey: { kind: 'wrong', fingerprintSha256: `SHA256:${'A'.repeat(43)}` } as never })),
    );
  });

  it('a non-canonical fingerprint spelling refuses — the persisted pin is the canonical form', () => {
    for (const fingerprint of [
      `256 ${REAL_HOST_KEY.fingerprintSha256} fixture (ED25519)`,
      `${REAL_HOST_KEY.fingerprintSha256}=`,
      REAL_HOST_KEY.fingerprintSha256.toLowerCase(),
      `trusted ${REAL_HOST_KEY.fingerprintSha256}`,
    ]) {
      expectRefused(
        'gateway-host-key-unpinned',
        classifySshConnect(connectOptions({ expectedHostKey: { kind: 'sha256-fingerprint', fingerprintSha256: fingerprint } })),
      );
    }
  });

  it('a wire-key pin needs structurally valid wire fields that agree with each other', () => {
    for (const pin of [
      { kind: 'wire-key', fingerprintSha256: REAL_HOST_KEY.fingerprintSha256, keyType: 'ssh-ed25519', keyB64: 'AAAA' },
      { kind: 'wire-key', fingerprintSha256: REAL_HOST_KEY.fingerprintSha256, keyType: 'ssh-ed25519' },
      { kind: 'wire-key', fingerprintSha256: REAL_HOST_KEY.fingerprintSha256, keyType: 'ssh ed25519!', keyB64: REAL_HOST_KEY.keyB64 },
      { kind: 'wire-key', fingerprintSha256: REAL_HOST_KEY.fingerprintSha256, keyType: 'ssh-rsa', keyB64: REAL_HOST_KEY.keyB64 },
      { kind: 'wire-key', fingerprintSha256: REAL_HOST_KEY.fingerprintSha256, keyType: 'ssh-ed25519', keyB64: 'not base64!!' },
    ]) {
      expectRefused('gateway-host-key-unpinned', classifySshConnect(connectOptions({ expectedHostKey: pin as never })));
    }
  });
});

describe('the real caller handoff preserves raw transport intent for the classifier', () => {
  /** The one real in-core builder of connect options: ConnectionController's
   * dial spread (`...host, requestId, generationId, expectedHostKey, …`).
   * The captured payload is what a capability implementation would receive
   * and run `classifySshConnect` on. */
  class CapturingCapability {
    readonly connectCalls: SshConnectOptions[] = [];
    private ordinal = 0;

    addListener = async () => ({ remove: async () => undefined });

    connect = async (options: SshConnectOptions): Promise<SshConnectResult> => {
      this.connectCalls.push(options);
      return {
        requestId: options.requestId,
        connectionId: `connection-${++this.ordinal}`,
        generationId: options.generationId,
        hostKey: { ...REAL_HOST_KEY },
      };
    };

    cancelOperation = async (options: { requestId: string }) => ({ requestId: options.requestId, cancelled: true });

    closeConnection = async (ref: { requestId: string }) => ({ requestId: ref.requestId });
  }

  function trustStoreFor(pins: Map<string, HostKeyTrustPin>): HostKeyTrustStore {
    return {
      get: async (hostId) => pins.get(hostId) ?? null,
      record: async (hostId, pin) => {
        pins.set(hostId, pin);
      },
    };
  }

  async function capturedConnectOptions(host: SshHostTarget): Promise<SshConnectOptions> {
    const capability = new CapturingCapability();
    const pins = new Map<string, HostKeyTrustPin>([[host.hostId, { kind: 'wire-key', ...REAL_HOST_KEY }]]);
    const controller = new ConnectionController({
      capability: capability as unknown as SshCapability,
      trustStore: trustStoreFor(pins),
      createId: (() => {
        let n = 0;
        return () => `req-${++n}`;
      })(),
      retryDelaysMs: [0],
    });
    try {
      const result = await controller.connect(host);
      expect(result.ok).toBe(true);
    } finally {
      await controller.close();
    }
    expect(capability.connectCalls.length).toBe(1);
    return capability.connectCalls[0]!;
  }

  it("an ordinary direct host's connect payload carries no marker keys and classifies direct", async () => {
    const options = await capturedConnectOptions(target());
    expect(Object.prototype.hasOwnProperty.call(options, 'gateway')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'link')).toBe(false);
    expect(classifySshConnect(options)).toEqual({ kind: 'direct' });
  });

  it('a link host rides the handoff verbatim and classifies link', async () => {
    const options = await capturedConnectOptions(target({ link: VALID_LINK, credential: { kind: 'link-token', token: 'relay-secret' } }));
    expect(options.link).toEqual(VALID_LINK);
    expect(classifySshConnect(options)).toEqual({ kind: 'link' });
  });

  it('a gateway host arrives with its RAW marker and classifies to the NORMALIZED target', async () => {
    const rawMarker = { serverUrl: 'https://gateway.pocketshell.io', deviceId: ' dev-01 ' };
    const options = await capturedConnectOptions(target({ gateway: rawMarker }));
    expect(options.gateway).toEqual(rawMarker);
    expect(options.expectedHostKey).toEqual(REAL_WIRE_KEY_PIN);
    expect(classifySshConnect(options)).toEqual({
      kind: 'gateway',
      gateway: { serverUrl: GATEWAY_DEFAULT_SERVER_URL, deviceId: 'dev-01' },
    });
  });

  it('an own undefined marker survives the handoff and refuses — no silent drop, no fallback', async () => {
    const host = target() as Record<string, unknown>;
    host['gateway'] = undefined;
    const options = (await capturedConnectOptions(host as unknown as SshHostTarget)) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(options, 'gateway')).toBe(true);
    expect(options['gateway']).toBeUndefined();
    expectRefused('gateway-marker-invalid', classifySshConnect(options as unknown as SshConnectOptions));
  });
});
