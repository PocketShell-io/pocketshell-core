import { describe, expect, it } from 'vitest';
import {
  assembleSyncSet,
  mirrorGatewayAuth,
  parseSyncPayloadResult,
  serializeSyncPayload,
  type SyncHostEntry,
} from '../../src/index';

/**
 * Design s7: a host's gatewayAuth lives in the encrypted vault index and is
 * mirrored, as a non-secret flag, onto the host entry in the `main` payload
 * so the host agent can pick its AuthorizedKeysFile without the vault.
 */
const KEY = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('gatewayAuth mirrored onto main host entries', () => {
  it('mirrors bound hosts, clears unbound ones, leaves others untouched', () => {
    const hosts: SyncHostEntry[] = [
      { name: 'prod', hostname: 'p.example' },
      { name: 'stale', hostname: 's.example', gatewayAuth: 'managed' },
      { name: 'web', hostname: 'w.example', port: 2222 },
    ];
    const out = mirrorGatewayAuth(hosts, {
      prod: { keyId: KEY, gatewayAuth: 'both' },
      web: { keyId: KEY, gatewayAuth: 'host' },
    });
    expect(out).toEqual([
      { name: 'prod', hostname: 'p.example', gatewayAuth: 'both' },
      { name: 'stale', hostname: 's.example' },
      { name: 'web', hostname: 'w.example', port: 2222, gatewayAuth: 'host' },
    ]);
    expect(hosts[0]).not.toHaveProperty('gatewayAuth');
  });

  it('survives parse, merge (local wins, remote carried) and serialize', () => {
    const remote: SyncHostEntry[] = [{ name: 'prod', hostname: 'p.example', gatewayAuth: 'managed' }];
    const local: SyncHostEntry[] = [{ name: 'prod', hostname: 'p.example' }];
    const carried = assembleSyncSet(local, remote, ['prod']);
    expect(carried[0]?.gatewayAuth).toBe('managed');
    const overridden = assembleSyncSet([{ name: 'prod', hostname: 'p.example', gatewayAuth: 'host' }], remote, ['prod']);
    expect(overridden[0]?.gatewayAuth).toBe('host');
    const parsed = parseSyncPayloadResult(serializeSyncPayload(overridden));
    expect(parsed.kind === 'ok' && parsed.hosts[0]?.gatewayAuth).toBe('host');
  });
});
