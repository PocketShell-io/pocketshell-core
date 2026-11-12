import type { KeyVaultStore } from './store';
import type { GatewayAuthPolicy } from './types';

/**
 * One-time migration of the web's legacy `keys` slot (design section 1):
 * plaintext `{v:1, secrets:{<host name>:{privateKeyPem?, password?, keyPassphrase?}}}`
 * keyed by the ACCOUNT host alias — the same key the vault index uses — so
 * hosts map over by name with no lookup.
 */

export interface LegacyHostSecret {
  privateKeyPem?: string;
  password?: string;
  keyPassphrase?: string;
}

/** One credential to move, already split per host. */
export type LegacyMigrationItem =
  | { hostAlias: string; kind: 'key'; pem: string; keyPassphrase?: string }
  | { hostAlias: string; kind: 'password'; password: string };

export type LegacyKeysParseResult = { kind: 'ok'; items: LegacyMigrationItem[] } | { kind: 'invalid' };

/** Parse the decrypted legacy `keys` slot. Empty fields are skipped; any other shape is invalid. */
export function parseLegacyKeysSlot(plaintext: string): LegacyKeysParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    return { kind: 'invalid' };
  }
  if (typeof raw !== 'object' || raw === null) return { kind: 'invalid' };
  const root = raw as Record<string, unknown>;
  if (root.v !== 1 || typeof root.secrets !== 'object' || root.secrets === null || Array.isArray(root.secrets)) {
    return { kind: 'invalid' };
  }
  const items: LegacyMigrationItem[] = [];
  for (const [hostAlias, value] of Object.entries(root.secrets as Record<string, unknown>)) {
    if (hostAlias === '' || typeof value !== 'object' || value === null) return { kind: 'invalid' };
    const secret = value as Record<string, unknown>;
    const pem = typeof secret.privateKeyPem === 'string' ? secret.privateKeyPem.trim() : '';
    const password = typeof secret.password === 'string' ? secret.password : '';
    const keyPassphrase = typeof secret.keyPassphrase === 'string' ? secret.keyPassphrase : '';
    if (pem !== '') items.push({ hostAlias, kind: 'key', pem, ...(keyPassphrase ? { keyPassphrase } : {}) });
    if (password !== '') items.push({ hostAlias, kind: 'password', password });
  }
  return { kind: 'ok', items };
}

/** Per-item outcome, so the UI can show what moved and what needs the user. */
export type LegacyMigrationOutcome =
  | { hostAlias: string; kind: 'key' | 'password'; status: 'migrated'; keyId: string; bound: boolean }
  /** A key the stored keyPassphrase did not open (or none was stored). The user re-uploads it. */
  | { hostAlias: string; kind: 'key'; status: 'needsPassphrase' | 'wrongPassphrase' }
  | { hostAlias: string; kind: 'key' | 'password'; status: 'failed'; message: string };

export interface LegacyMigrationReport {
  outcomes: LegacyMigrationOutcome[];
  /** True when nothing failed: the caller may delete the legacy `keys` slot. */
  complete: boolean;
}

/**
 * Move legacy items into an UNLOCKED vault: each key is added (decrypted
 * with its stored keyPassphrase) and each password stored, then the host is
 * bound to it. A host with both a key and a password binds the key; the
 * password is still kept as its own entry. Bindings that already exist are
 * left alone. Idempotent: re-running deduplicates keys by keyId.
 */
export async function migrateLegacyKeys(
  store: KeyVaultStore,
  items: readonly LegacyMigrationItem[],
  options: { gatewayAuth?: GatewayAuthPolicy } = {},
): Promise<LegacyMigrationReport> {
  const gatewayAuth = options.gatewayAuth ?? 'both';
  const outcomes: LegacyMigrationOutcome[] = [];
  const keyHosts = new Set(items.filter((item) => item.kind === 'key').map((item) => item.hostAlias));
  for (const item of items) {
    let keyId: string;
    if (item.kind === 'key') {
      const added = await store.addKey(item.pem, item.hostAlias, item.keyPassphrase ?? null);
      if (added.kind === 'needsPassphrase' || added.kind === 'wrongPassphrase') {
        outcomes.push({ hostAlias: item.hostAlias, kind: 'key', status: added.kind });
        continue;
      }
      if (added.kind !== 'ok') {
        outcomes.push({ hostAlias: item.hostAlias, kind: 'key', status: 'failed', message: describeFailure(added) });
        continue;
      }
      keyId = added.entry.keyId;
    } else {
      const existing = store.listKeys().find((entry) => entry.type === 'password' && entry.name === `${item.hostAlias} password`);
      if (existing) {
        const current = await store.decryptKey(existing.keyId);
        if (current.kind === 'password' && current.password === item.password) {
          outcomes.push({ hostAlias: item.hostAlias, kind: 'password', status: 'migrated', keyId: existing.keyId, bound: false });
          continue;
        }
      }
      const added = await store.addPassword(item.password, `${item.hostAlias} password`);
      if (added.kind !== 'ok') {
        outcomes.push({ hostAlias: item.hostAlias, kind: 'password', status: 'failed', message: describeFailure(added) });
        continue;
      }
      keyId = added.entry.keyId;
    }
    const wantsBinding = item.kind === 'key' || !keyHosts.has(item.hostAlias);
    let bound = false;
    if (wantsBinding && store.getHostBinding(item.hostAlias) === null) {
      const result = await store.bindHost(item.hostAlias, keyId, gatewayAuth);
      if (result.kind !== 'ok') {
        outcomes.push({ hostAlias: item.hostAlias, kind: item.kind, status: 'failed', message: describeFailure(result) });
        continue;
      }
      bound = true;
    }
    outcomes.push({ hostAlias: item.hostAlias, kind: item.kind, status: 'migrated', keyId, bound });
  }
  return { outcomes, complete: outcomes.every((outcome) => outcome.status === 'migrated') };
}

function describeFailure(result: { kind: string; message?: string }): string {
  return result.message ?? result.kind;
}
