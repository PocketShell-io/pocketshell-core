/**
 * The transport seam. Everything above this line in the app tree imports
 * `api` from here and never learns what platform it runs on.
 *
 * The host app provides the implementation at startup:
 *   - desktop: provideApi(window.api)  (Electron IPC via the preload bridge)
 *   - web:     provideApi(webApi)      (the browser transport module)
 *
 * `api` is a deferred proxy so store module scope can hold it before the
 * platform has provided anything; touching a property before provideApi()
 * is the bug it refuses to hide.
 */
import type { PocketShellApi } from './api';

let provided: PocketShellApi | null = null;

export function provideApi(impl: PocketShellApi): void {
  provided = impl;
}

export const api: PocketShellApi = new Proxy({} as PocketShellApi, {
  get(_target, prop) {
    if (provided === null) {
      throw new Error(
        `api.${String(prop)} used before the platform transport was provided — call provideApi() at app startup`,
      );
    }
    return Reflect.get(provided as object, prop);
  },
});
