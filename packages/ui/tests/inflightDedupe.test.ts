import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useSessionsStore } from '../src/app/stores/sessions';
import { useProjectsStore } from '../src/app/stores/projects';

/** #3141: one in-flight listing / $HOME lookup per connection. */
beforeEach(() => setActivePinia(createPinia()));

describe('sessions.refresh coalescing', () => {
  it('shares one host listing between concurrent callers on a connection', async () => {
    let release!: () => void;
    const sessionsListing = vi.fn(() => new Promise((r) => { release = () => r({ sessions: [], errors: [] }); }));
    provideApi({ helper: { sessionsListing, sessionsList: async () => [] } } as unknown as PocketShellApi);
    const store = useSessionsStore();
    const calls = [store.refresh('c1'), store.refresh('c1', { quiet: true }), store.refresh('c1')];
    expect(sessionsListing).toHaveBeenCalledTimes(1);
    expect(store.loading).toBe(true);
    release();
    await Promise.all(calls);
    expect(store.loading).toBe(false);
    // The flight is released: the next refresh lists again.
    const next = store.refresh('c1');
    await vi.waitFor(() => expect(sessionsListing).toHaveBeenCalledTimes(2));
    release(); await next;
  });
  it('does not share across connections', async () => {
    const sessionsListing = vi.fn(async () => ({ sessions: [], errors: [] }));
    provideApi({ helper: { sessionsListing, sessionsList: async () => [] } } as unknown as PocketShellApi);
    const store = useSessionsStore();
    await Promise.all([store.refresh('a'), store.refresh('b')]);
    expect(sessionsListing).toHaveBeenCalledTimes(2);
  });
});

describe('sessions.refresh after a mutation (#3141)', () => {
  it('a fresh refresh issued while a pre-mutation listing is in flight gets a second, later listing', async () => {
    const releases: Array<(rows: unknown[]) => void> = [];
    const sessionsListing = vi.fn(() => new Promise((r) => { releases.push((rows) => r({ sessions: rows, errors: [] })); }));
    provideApi({ helper: { sessionsListing, sessionsList: async () => [] } } as unknown as PocketShellApi);
    const store = useSessionsStore();
    const poll = store.refresh('c1', { quiet: true });          // pre-mutation listing
    const afterRename = store.refresh('c1', { fresh: true });   // mutation finished meanwhile
    const another = store.refresh('c1', { fresh: true });       // shares the one trailing listing
    expect(sessionsListing).toHaveBeenCalledTimes(1);
    releases[0]!([{ name: 'old-name' }]);
    await poll;
    await vi.waitFor(() => expect(sessionsListing).toHaveBeenCalledTimes(2));
    releases[1]!([{ name: 'new-name' }]);
    await Promise.all([afterRename, another]);
    expect(sessionsListing).toHaveBeenCalledTimes(2);
    expect(store.sessions.map((s) => s.name)).toEqual(['new-name']);
  });
  it('clear() drops the in-flight listing: it neither is joined nor writes afterwards', async () => {
    const releases: Array<(rows: unknown[]) => void> = [];
    const sessionsListing = vi.fn(() => new Promise((r) => { releases.push((rows) => r({ sessions: rows, errors: [] })); }));
    provideApi({ helper: { sessionsListing, sessionsList: async () => [] } } as unknown as PocketShellApi);
    const store = useSessionsStore();
    const old = store.refresh('c1');
    store.clear();
    const next = store.refresh('c1');
    expect(sessionsListing).toHaveBeenCalledTimes(2);
    releases[1]!([{ name: 'current' }]);
    await next;
    releases[0]!([{ name: 'closed-connection' }]);
    await old;
    expect(store.sessions.map((s) => s.name)).toEqual(['current']);
  });
});

describe('projects.ensureHome coalescing', () => {
  it('runs one realPath for concurrent callers and caches the result', async () => {
    let release!: () => void;
    const home = vi.fn(() => new Promise((r) => { release = () => r({ ok: true, home: '/home/me' }); }));
    provideApi({ projects: { home } } as unknown as PocketShellApi);
    const store = useProjectsStore();
    const calls = [store.ensureHome('c1'), store.ensureHome('c1'), store.ensureHome('c1')];
    expect(home).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all(calls)).toEqual(['/home/me', '/home/me', '/home/me']);
    expect(await store.ensureHome('c1')).toBe('/home/me');
    expect(home).toHaveBeenCalledTimes(1);
  });
  it('clear() drops the in-flight lookup so the next caller starts its own', async () => {
    const releases: Array<() => void> = [];
    const home = vi.fn(() => new Promise((r) => { releases.push(() => r({ ok: true, home: `/h${releases.length}` })); }));
    provideApi({ projects: { home } } as unknown as PocketShellApi);
    const store = useProjectsStore();
    void store.ensureHome('c1');
    store.clear();
    void store.ensureHome('c1');
    expect(home).toHaveBeenCalledTimes(2);
  });
  it('does not cache a failure: the next caller retries', async () => {
    const home = vi.fn().mockResolvedValueOnce({ ok: false, error: 'no' }).mockResolvedValueOnce({ ok: true, home: '/h' });
    provideApi({ projects: { home } } as unknown as PocketShellApi);
    const store = useProjectsStore();
    expect(await store.ensureHome('c1')).toBeNull();
    expect(await store.ensureHome('c1')).toBe('/h');
  });
});
