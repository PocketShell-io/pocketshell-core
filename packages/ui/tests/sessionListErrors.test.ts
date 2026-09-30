import { readFileSync } from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseHostSessionsList, type SessionSummary, type SessionsListResult } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useSessionsStore } from '../src/app/stores/sessions';
import SessionListErrorBanner from '../src/app/components/SessionListErrorBanner.vue';

// The captured `pocketshell==0.5.8` `sessions list --json` answer whose aplexer
// probe failed: no sessions, one host error.
const capturedErrors = parseHostSessionsList(
  readFileSync(new URL('../../../tests/fixtures/pocketshell-0.5.8/sessions-list-errors.json', import.meta.url), 'utf8'),
).errors;

const row = (name: string): SessionSummary => ({ name, created: 1, activity: 1, attached: false, path: '/work' });

function provideHelper(helper: Partial<PocketShellApi['helper']>): void {
  provideApi({ helper } as unknown as PocketShellApi);
}

async function renderBanner(): Promise<string> {
  const app = createSSRApp(SessionListErrorBanner);
  app.use(createPinia());
  return renderToString(app);
}

describe('session list errors in the shared session panel', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps the host errors from sessionsListing and shows the banner over an empty list', async () => {
    let answer: SessionsListResult = { sessions: [], errors: capturedErrors };
    provideHelper({ sessionsListing: async () => answer });
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useSessionsStore();

    await store.refresh('conn-1');
    expect(store.sessions).toEqual([]);
    expect(store.listErrors).toEqual(capturedErrors);

    const app = createSSRApp(SessionListErrorBanner);
    app.use(pinia);
    const html = await renderToString(app);
    expect(html).toContain('data-testid="session-list-errors"');
    expect(html).toContain('Some sessions may be missing: `/does/not/exist --json snapshot`');

    // The next listing that comes back clean takes the banner down.
    answer = { sessions: [row('main')], errors: [] };
    await store.refresh('conn-1', { quiet: true });
    expect(store.sessions.map((s) => s.name)).toEqual(['main']);
    expect(store.listErrors).toEqual([]);
    const clean = createSSRApp(SessionListErrorBanner);
    clean.use(pinia);
    expect(await renderToString(clean)).not.toContain('session-list-errors');
  });

  it('leaves the last errors in place when a refresh fails, and clear() drops them', async () => {
    let fail = false;
    provideHelper({
      sessionsListing: async () => {
        if (fail) throw new Error('transport lost');
        return { sessions: [], errors: [{ message: 'snapshot unreadable' }] };
      },
    });
    const store = useSessionsStore();
    await store.refresh('conn-1');
    fail = true;
    await store.refresh('conn-1');
    expect(store.error).toBe('transport lost');
    expect(store.listErrors).toEqual([{ message: 'snapshot unreadable' }]);
    store.clear();
    expect(store.listErrors).toEqual([]);
  });

  it('reports no list errors on a platform that only provides sessionsList', async () => {
    provideHelper({ sessionsList: async () => [row('alpha')] });
    const store = useSessionsStore();
    await store.refresh('conn-1');
    expect(store.sessions.map((s) => s.name)).toEqual(['alpha']);
    expect(store.listErrors).toEqual([]);
    expect(await renderBanner()).not.toContain('session-list-errors');
  });
});
