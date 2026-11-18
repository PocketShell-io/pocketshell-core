/**
 * The shared app's "handle Back" — one history-aware answer for every client
 * whose platform has a Back gesture (Android's system Back).
 *
 * `handleBack(router)` returns `true` when the app consumed the press and
 * `false` when there is nothing left to go back to, so the host decides what
 * "leave" means (Android minimises, it does not exit). The order is:
 *
 *   1. the topmost open layer (a dialog, sheet, palette, settings overlay);
 *   2. a maintenance tool (Ports, Monitor, Usage) -> the host workspace;
 *   3. any other host-level route (a folder workspace, Files, the session
 *      redirect, a client's own route such as Account or Add host) -> the
 *      host list;
 *   4. the host list is the root: not consumed.
 */
import type { RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from 'vue-router';
import { dismissTopLayer } from './extensions';
import { MAINTENANCE_ROOT } from './maintenance';

type RouteLike = Pick<RouteLocationNormalizedLoaded, 'name' | 'params'>;

/** Where Back goes from `route`, or `null` at the root (the host list). */
export function backTarget(route: RouteLike): RouteLocationRaw | null {
  const name = route.name === undefined || route.name === null ? '' : String(route.name);
  if (name === 'hosts') return null;
  if (name === 'folder' && route.params['folder'] === MAINTENANCE_ROOT) {
    return { name: 'host-sessions', params: { name: String(route.params['name']) } };
  }
  return { name: 'hosts' };
}

export function handleBack(router: Router): boolean {
  if (dismissTopLayer()) return true;
  const target = backTarget(router.currentRoute.value);
  if (target === null) return false;
  void router.push(target);
  return true;
}
