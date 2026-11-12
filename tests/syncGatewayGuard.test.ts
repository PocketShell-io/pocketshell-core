import { describe, expect, it } from 'vitest';
import {
  coerceHostEntries,
  hasGatewayMarker,
  SSH_CONFIG_TRANSPORTS,
  transportRefusalMessage,
  unsupportedTransport,
} from '../src/sync';
import {
  assembleSyncSet,
  parseSyncPayloadResult,
  serializeSyncPayload,
  type SyncHostEntry,
} from '../src/syncMerge';

/**
 * Issue #3059 — the gateway transport marker on synced host entries.
 *
 * The gateway transport initially ships in the browser only. Every guard in
 * this file pins the same contract: the marker is carried (sync merge, wire
 * round trip, IPC coercion) but never interpreted by code that cannot act on
 * it, and never allowed to degrade into an ordinary SSH host.
 */

function host(name: string, extra: Record<string, unknown> = {}): SyncHostEntry {
  return {
    name,
    hostname: `${name}.example.com`,
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
    ...extra,
  } as SyncHostEntry;
}

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'device-1' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };

describe('hasGatewayMarker — presence, not shape', () => {
  it('is false for an ordinary host without the key', () => {
    expect(hasGatewayMarker(host('box') as unknown as object)).toBe(false);
  });

  it('is true for a valid target, null, a malformed value, and an undefined value', () => {
    expect(hasGatewayMarker(host('a', { gateway: VALID_GATEWAY }))).toBe(true);
    expect(hasGatewayMarker(host('b', { gateway: null }))).toBe(true);
    expect(hasGatewayMarker(host('c', { gateway: { nope: true } }))).toBe(true);
    expect(hasGatewayMarker(host('d', { gateway: 'wss://surprise' }))).toBe(true);
    expect(hasGatewayMarker(host('e', { gateway: undefined }))).toBe(true);
  });

  it('does not confuse the marker with other keys or inherited properties', () => {
    expect(hasGatewayMarker(host('f', { gateways: null }))).toBe(false);
    const inherited = Object.create({ gateway: VALID_GATEWAY }) as object;
    expect(hasGatewayMarker(inherited)).toBe(false);
  });
});

describe('valid and malformed markers survive the sync merge', () => {
  it('keeps a valid gateway marker when the local entry wins', () => {
    const merged = assembleSyncSet(
      [host('box', { gateway: VALID_GATEWAY })],
      [host('box', { user: 'remote-user' })],
      ['box'],
    );
    expect(merged).toHaveLength(1);
    expect((merged[0] as Record<string, unknown>)['gateway']).toEqual(VALID_GATEWAY);
  });

  it('carries an account-only gateway marker through a restore', () => {
    const merged = assembleSyncSet([], [host('box', { gateway: VALID_GATEWAY })], ['box']);
    expect((merged[0] as Record<string, unknown>)['gateway']).toEqual(VALID_GATEWAY);
  });

  it('preserves a malformed marker verbatim instead of normalizing or dropping it', () => {
    const malformed = { deviceId: 42, serverUrl: null };
    const merged = assembleSyncSet(
      [host('box', { gateway: malformed })],
      [host('box')],
      ['box'],
    );
    expect((merged[0] as Record<string, unknown>)['gateway']).toEqual(malformed);
  });

  it('does not invent a marker for hosts that never had one', () => {
    const merged = assembleSyncSet([host('box')], [host('box', { user: 'remote' })], ['box']);
    expect(Object.prototype.hasOwnProperty.call(merged[0], 'gateway')).toBe(false);
  });
});

describe('markers survive the wire round trip', () => {
  it('keeps a valid gateway marker through serialize → strict parse', () => {
    const plaintext = serializeSyncPayload([host('box', { gateway: VALID_GATEWAY })]);
    const parsed = parseSyncPayloadResult(plaintext);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect((parsed.hosts[0] as Record<string, unknown>)['gateway']).toEqual(VALID_GATEWAY);
  });

  it('keeps a null or malformed marker through serialize → strict parse, still a valid entry', () => {
    for (const marker of [null, { unexpected: ['shape'] }]) {
      const plaintext = serializeSyncPayload([host('box', { gateway: marker })]);
      const parsed = parseSyncPayloadResult(plaintext);
      expect(parsed.kind).toBe('ok');
      if (parsed.kind !== 'ok') continue;
      expect((parsed.hosts[0] as Record<string, unknown>)['gateway']).toEqual(marker);
    }
  });
});

describe('coerceHostEntries refuses transport-marked entries instead of coercing them', () => {
  it('coerces ordinary entries and keeps dropping unusable ones', () => {
    const result = coerceHostEntries([
      host('good'),
      { nope: true },
      { name: '', hostname: 'x' },
    ]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.hosts.map((h) => h.name)).toEqual(['good']);
  });

  it('is invalid for a non-array', () => {
    expect(coerceHostEntries('hosts').kind).toBe('invalid');
    expect(coerceHostEntries(null).kind).toBe('invalid');
  });

  it('refuses a valid gateway marker mixed into an ordinary batch, naming the entry', () => {
    const result = coerceHostEntries([host('plain'), host('nat-box', { gateway: VALID_GATEWAY })]);
    expect(result).toEqual({
      kind: 'transport-unsupported',
      index: 1,
      name: 'nat-box',
      reason: 'gateway-unsupported',
      message: transportRefusalMessage('gateway-unsupported', 'nat-box'),
    });
  });

  it('refuses a null marker — a present marker with no usable shape is still gateway intent', () => {
    const result = coerceHostEntries([host('box', { gateway: null })]);
    expect(result.kind === 'transport-unsupported' && result.reason).toBe('gateway-unsupported');
  });

  it('refuses a malformed marker', () => {
    const result = coerceHostEntries([host('box', { gateway: { device: 'almost' } })]);
    expect(result.kind === 'transport-unsupported' && result.reason).toBe('gateway-unsupported');
  });

  it('refuses an entry that carries BOTH link and gateway — the conflict fails closed, never falls back to link', () => {
    const result = coerceHostEntries([host('both', { link: VALID_LINK, gateway: VALID_GATEWAY })]);
    expect(result.kind === 'transport-unsupported' && result.reason).toBe('gateway-unsupported');
  });

  it('refuses with a null name when the entry has none it can cite', () => {
    const result = coerceHostEntries([{ name: 7, hostname: 'h', gateway: VALID_GATEWAY }]);
    expect(result).toEqual({
      kind: 'transport-unsupported',
      index: 0,
      name: null,
      reason: 'gateway-unsupported',
      message: transportRefusalMessage('gateway-unsupported', null),
    });
  });

  it.each([
    ['valid', VALID_LINK],
    ['null', null],
    ['malformed string', 'wss://relay'],
    ['malformed object', { relayUrl: '' }],
  ])('never returns a %s link-marked entry as a plain host — the batch refuses with the shared text', (_l, link) => {
    const result = coerceHostEntries([host('plain'), host('nat-box', { link })]);
    expect(result).toEqual({
      kind: 'transport-unsupported',
      index: 1,
      name: 'nat-box',
      reason: 'link-unsupported',
      message: transportRefusalMessage('link-unsupported', 'nat-box'),
    });
  });

  it('is the SAME decision as unsupportedTransport with the config-file capabilities (one decision in core)', () => {
    const shapes: Array<Record<string, unknown>> = [
      {},
      { gateway: VALID_GATEWAY },
      { gateway: null },
      { gateway: 'junk' },
      { link: VALID_LINK },
      { link: null },
      { link: 'junk' },
      { link: VALID_LINK, gateway: VALID_GATEWAY },
      { link: null, gateway: null },
    ];
    expect(SSH_CONFIG_TRANSPORTS).toEqual({ gateway: false, link: false });
    for (const extra of shapes) {
      const entry = host('box', extra);
      const decision = unsupportedTransport(entry, SSH_CONFIG_TRANSPORTS);
      const result = coerceHostEntries([entry]);
      if (decision.refused) {
        expect(result).toEqual({
          kind: 'transport-unsupported',
          index: 0,
          name: 'box',
          reason: decision.reason,
          message: decision.message,
        });
      } else {
        expect(result.kind).toBe('ok');
      }
    }
  });
});
