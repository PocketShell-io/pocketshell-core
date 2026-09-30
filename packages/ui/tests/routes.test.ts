import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router';
import { createAppRoutes, SHARED_ROUTE_NAMES } from '@ui/app/routes';

const Stub = defineComponent({ render: () => h('div') });

function names(routes: readonly RouteRecordRaw[]): string[] {
  return routes.flatMap((r) => [...(r.name ? [String(r.name)] : []), ...names(r.children ?? [])]);
}

describe('createAppRoutes', () => {
  it('carries the shared map every client navigates by', () => {
    const routes = createAppRoutes();
    expect(names(routes)).toEqual([...SHARED_ROUTE_NAMES]);
    expect(routes.map((r) => r.path)).toEqual(['/', '/host/:name', '/:pathMatch(.*)*']);
    const host = routes.find((r) => r.path === '/host/:name');
    expect(host?.children?.map((c) => c.path)).toEqual(['', 'folder/:folder', 'session/:session']);
  });

  it('adds client routes after the shared ones and before the catch-all', () => {
    const routes = createAppRoutes([{ path: '/login', name: 'login', component: Stub }]);
    expect(routes.map((r) => r.path)).toEqual(['/', '/host/:name', '/login', '/:pathMatch(.*)*']);
  });

  it('resolves shared, client and unknown paths in a real router', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: createAppRoutes([{ path: '/android/hosts', name: 'android-hosts', component: Stub }]),
    });
    expect(router.resolve('/host/dev/folder/~%2Fgit%2Fx').name).toBe('folder');
    expect(router.resolve('/host/dev').name).toBe('host-sessions');
    expect(router.resolve('/android/hosts').name).toBe('android-hosts');
    await router.push('/nowhere');
    expect(router.currentRoute.value.name).toBe('hosts');
  });

  it('refuses a client route that shadows a shared name or path', () => {
    expect(() => createAppRoutes([{ path: '/elsewhere', name: 'hosts', component: Stub }])).toThrow(
      /route name "hosts" is defined twice/,
    );
    expect(() => createAppRoutes([{ path: '/', name: 'home', component: Stub }])).toThrow(
      /route path "\/" is already a shared route/,
    );
  });

  it('returns a fresh map per call, so one client cannot mutate another', () => {
    const a = createAppRoutes();
    a.pop();
    expect(createAppRoutes()).toHaveLength(3);
  });
});
