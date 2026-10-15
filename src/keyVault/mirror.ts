import type { SyncHostEntry } from '../syncMerge';
import type { HostKeyBinding } from './types';

/**
 * Mirror the vault's per-host gateway policy onto the `main` payload's host
 * entries (design s7): a bound host gets its binding's `gatewayAuth`, an
 * unbound host loses any stale copy, and every other field is left as is.
 * Bindings are keyed by the account host alias, the entry's `name`. Returns
 * new entries; the input is not modified. Run it on the hosts a client
 * uploads, while the vault is unlocked.
 */
export function mirrorGatewayAuth<T extends SyncHostEntry>(
  hosts: readonly T[],
  bindings: Readonly<Record<string, HostKeyBinding>>,
): T[] {
  return hosts.map((host) => {
    const binding = Object.prototype.hasOwnProperty.call(bindings, host.name) ? bindings[host.name] : undefined;
    const { gatewayAuth: _previous, ...rest } = host;
    return (binding ? { ...rest, gatewayAuth: binding.gatewayAuth } : rest) as T;
  });
}
