/**
 * Where "CLI sessions" points: the web page that lists the account's
 * `pocketshell login` sessions and revokes them.
 *
 * The page lives in the web app. The web client registers it as the route
 * named `device-sessions` (/device/sessions), so there the link is an in-app
 * navigation on the same origin — no new tab, no second sign-in. Any other
 * client (the desktop's account window) has no such route and opens the
 * absolute URL instead, through `target="_blank"`, which the desktop's
 * window-open policy hands to the system browser. Nothing here branches on
 * the platform: the route existing IS the capability.
 */
import type { RouteLocationRaw, Router } from 'vue-router';

/** The web client's route name for the CLI sessions page. */
export const CLI_SESSIONS_ROUTE_NAME = 'device-sessions';

/** The page's absolute address, for clients without the route. */
export const CLI_SESSIONS_URL = 'https://app.pocketshell.io/device/sessions';

export type CliSessionsTarget =
  | { kind: 'route'; to: RouteLocationRaw }
  | { kind: 'external'; href: string };

/** The in-app route when this client's router has it, else the absolute URL. */
export function cliSessionsTarget(router: Router | undefined): CliSessionsTarget {
  if (router?.hasRoute(CLI_SESSIONS_ROUTE_NAME)) {
    return { kind: 'route', to: { name: CLI_SESSIONS_ROUTE_NAME } };
  }
  return { kind: 'external', href: CLI_SESSIONS_URL };
}
