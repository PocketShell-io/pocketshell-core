import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { HostEntry } from '@pocketshell/core';
import type { PocketShellApi } from '../src/app/api';
import { provideApi } from '../src/app/ipc';
import { useConnectionStore } from '../src/app/stores/connection';

// key-vault (W3): the platform resolves a host's vault key binding by the
// ACCOUNT host alias. Two hosts on the same host:port must not share the
// first one's binding, so every dial names its alias.

function host(name: string): HostEntry {
  return {
    name,
    hostname: '203.0.113.7',
    port: 22,
    user: 'root',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
  };
}

describe('ssh.connect names the host alias', () => {
  it('sends HostEntry.name as hostAlias, distinct for two hosts on one address', async () => {
    const connects: Array<Record<string, unknown>> = [];
    provideApi({
      ssh: {
        onState: () => () => undefined,
        connect: async (payload: Record<string, unknown>) => {
          connects.push(payload);
          return { ok: false, error: 'stop here' };
        },
      },
    } as unknown as PocketShellApi);
    setActivePinia(createPinia());
    const connection = useConnectionStore();
    await connection.connect(host('hetzner-prod'));
    await connection.connect(host('hetzner-staging'));
    expect(connects.map((payload) => payload.hostAlias)).toEqual(['hetzner-prod', 'hetzner-staging']);
  });
});
