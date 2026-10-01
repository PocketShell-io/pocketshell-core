/**
 * The shared app's route map, one copy for every client.
 *
 * Three levels, each with a route so "back" is a real navigation:
 *   hosts          -> pick a host
 *   host-sessions  -> connected host, no folder picked yet. The session panel
 *                     is part of the host shell, so this route only supplies
 *                     the right pane's empty state.
 *   folder         -> one FOLDER's workspace: a tab per session in it, plus
 *                     one or more Files tabs.
 *
 * `:folder` is the folder's `directoryKey` — `~/git/dtc-website`. vue-router
 * encodes route params, so the slashes and the `~` survive a round trip
 * without any escaping of our own. The active tab is a QUERY parameter
 * (`?tab=<id>`) rather than a path segment: it is a view preference within one
 * destination, and a Files tab has no name that belongs in a path. Omitting it
 * selects the first tab.
 *
 * `session/:session` used to BE the workspace route. It is now a resolver that
 * replaces itself with the folder holding that session — see
 * views/SessionRedirectView.vue for why the old shape is honoured.
 *
 * A client adds its OWN routes through `extra` (the web's /login and
 * /account, Android's host form) and picks its own history — memory for a
 * single-file shell, web history for a browser tab. Those are the only
 * per-client parts; the map itself is not copied.
 */
import type { RouteRecordRaw } from 'vue-router';
import HostPickerView from './views/HostPickerView.vue';
import HostWorkspaceView from './views/HostWorkspaceView.vue';
import FolderWorkspaceView from './views/FolderWorkspaceView.vue';
import SessionPlaceholderView from './views/SessionPlaceholderView.vue';
import SessionRedirectView from './views/SessionRedirectView.vue';

/** The route names the shared views navigate by. */
export const SHARED_ROUTE_NAMES = ['hosts', 'host-sessions', 'folder', 'session'] as const;

function sharedRoutes(): RouteRecordRaw[] {
  return [
    { path: '/', name: 'hosts', component: HostPickerView },
    {
      path: '/host/:name',
      component: HostWorkspaceView,
      children: [
        { path: '', name: 'host-sessions', component: SessionPlaceholderView },
        { path: 'folder/:folder', name: 'folder', component: FolderWorkspaceView },
        { path: 'session/:session', name: 'session', component: SessionRedirectView },
      ],
    },
  ];
}

function collectNames(routes: readonly RouteRecordRaw[], into: Map<string, string>): void {
  for (const route of routes) {
    if (route.name !== undefined) {
      const name = String(route.name);
      if (into.has(name)) throw new Error(`route name "${name}" is defined twice (${into.get(name)} and ${route.path})`);
      into.set(name, route.path);
    }
    if (route.children) collectNames(route.children, into);
  }
}

/**
 * The shared routes, then `extra`, then a catch-all back to the picker. A
 * client route may not reuse a shared route's name or path — the shared views
 * navigate by those names, so shadowing one would silently re-point them.
 */
export function createAppRoutes(extra: readonly RouteRecordRaw[] = []): RouteRecordRaw[] {
  const shared = sharedRoutes();
  const paths = new Set(shared.map((r) => r.path));
  for (const route of extra) {
    if (paths.has(route.path)) throw new Error(`route path "${route.path}" is already a shared route`);
    paths.add(route.path);
  }
  const routes: RouteRecordRaw[] = [...shared, ...extra, { path: '/:pathMatch(.*)*', redirect: '/' }];
  collectNames(routes, new Map());
  return routes;
}
