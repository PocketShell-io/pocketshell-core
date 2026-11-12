import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PocketShellApi } from '../src/app/api';
import { provideApi } from '../src/app/ipc';
import { useAgentsStore } from '../src/app/stores/agents';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('agent engine catalog requests', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('ignores an older same-connection response and its completion state', async () => {
    const olderKinds = deferred<string[] | null>();
    const newerKinds = deferred<string[] | null>();
    const staleKinds = deferred<string[] | null>();
    const latestKinds = deferred<string[] | null>();
    const olderBinaries = deferred<string[] | null>();
    const newerBinaries = deferred<string[] | null>();
    const staleBinaries = deferred<string[] | null>();
    const latestBinaries = deferred<string[] | null>();
    const kindResponses = [olderKinds, newerKinds, staleKinds, latestKinds];
    const binaryResponses = [olderBinaries, newerBinaries, staleBinaries, latestBinaries];
    let kindCall = 0;
    let binaryCall = 0;

    provideApi({
      agent: {
        kinds: vi.fn(() => kindResponses[kindCall++]!.promise),
        binaries: vi.fn(() => binaryResponses[binaryCall++]!.promise),
      },
    } as unknown as PocketShellApi);
    const agents = useAgentsStore();

    const older = agents.loadAgentKinds('conn-1');
    const newer = agents.loadAgentKinds('conn-1');
    newerKinds.resolve(['new-engine']);
    newerBinaries.resolve(['pocketshell']);
    await newer;

    expect(agents.agentKinds).toEqual(['new-engine']);
    expect(agents.agentBinaries).toEqual(['pocketshell']);
    expect(agents.agentKindsProbing).toBe(false);
    expect(agents.agentKindsResolved).toBe(true);

    olderKinds.resolve(['old-engine']);
    olderBinaries.resolve(['old-launcher']);
    await older;

    expect(agents.agentKinds).toEqual(['new-engine']);
    expect(agents.agentBinaries).toEqual(['pocketshell']);
    expect(agents.agentKindsProbing).toBe(false);
    expect(agents.agentKindsResolved).toBe(true);

    // A later open starts another query on the same connection. An older
    // response that arrives during it must not finish the newer request.
    const stale = agents.loadAgentKinds('conn-1');
    const latest = agents.loadAgentKinds('conn-1');
    expect(agents.agentKindsProbing).toBe(true);
    expect(agents.agentKindsResolved).toBe(false);

    staleKinds.resolve(['stale-engine']);
    staleBinaries.resolve(['stale-launcher']);
    await stale;

    expect(agents.agentKinds).toBeNull();
    expect(agents.agentBinaries).toBeNull();
    expect(agents.agentKindsProbing).toBe(true);
    expect(agents.agentKindsResolved).toBe(false);

    latestKinds.resolve(['latest-engine']);
    latestBinaries.resolve(['pocketshell']);
    await latest;

    expect(agents.agentKinds).toEqual(['latest-engine']);
    expect(agents.agentBinaries).toEqual(['pocketshell']);
    expect(agents.agentKindsProbing).toBe(false);
    expect(agents.agentKindsResolved).toBe(true);
  });
});
