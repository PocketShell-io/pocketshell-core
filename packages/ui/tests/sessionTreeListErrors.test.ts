// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionsListResult } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useConnectionStore } from '../src/app/stores/connection';
import { useSessionsStore } from '../src/app/stores/sessions';
import SessionTree from '../src/app/components/SessionTree.vue';

// The live `pocketshell==0.5.8` listing whose aplexer probe failed (captured
// from the Docker fixture; same document as the core 0.5.8 vector).
const capturedErrors = JSON.parse(
  // jsdom replaces the global URL, so resolve the fixture as a plain path.
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/pocketshell-0.5.8/sessions-list-errors.json'),
    'utf8',
  ),
) as SessionsListResult;

/**
 * A catch-all transport: every `group.method` resolves `undefined` unless
 * overridden. Deliberately the same shape as the desktop suite's doubles, so
 * the panel is mounted against an API that answers everything.
 */
function provideTransport(overrides: Record<string, (...args: unknown[]) => unknown>): void {
  const group = (name: string) => new Proxy({}, {
    get: (_target, method: string) => overrides[`${name}.${method}`]
      ?? (method.startsWith('on') ? () => () => undefined : async () => undefined),
  });
  provideApi(new Proxy({}, { get: (_target, name: string) => group(name) }) as unknown as PocketShellApi);
}

async function mountConnectedTree(listing: SessionsListResult) {
  provideTransport({
    'helper.sessionsListing': async () => listing,
    'helper.sessionsList': async () => listing.sessions,
    'helper.warnings': async () => [],
    'projects.home': async () => ({ ok: true, home: '/home/testuser', error: null }),
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  const connection = useConnectionStore(pinia) as unknown as { connectionId: string | null };
  connection.connectionId = 'fixture-host';
  const wrapper = mount(SessionTree, { global: { plugins: [pinia] }, attachTo: document.body });
  await useSessionsStore(pinia).refresh('fixture-host');
  await flushPromises();
  return wrapper;
}

let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the session panel mounts the list-errors banner', () => {
  it('shows "Some sessions may be missing" above the tree when the host listing carried errors', async () => {
    mounted = await mountConnectedTree(capturedErrors);
    const banner = mounted.find('[data-testid="session-list-errors"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toBe(
      'Some sessions may be missing: `/does/not/exist --json snapshot` and `/does/not/exist --json list` both failed or returned unreadable JSON',
    );
  });

  it('shows no banner for a clean listing', async () => {
    mounted = await mountConnectedTree({ sessions: [], errors: [] });
    expect(mounted.find('[data-testid="session-list-errors"]').exists()).toBe(false);
  });
});
