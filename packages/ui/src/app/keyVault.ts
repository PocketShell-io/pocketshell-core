/**
 * The account key vault in the shared UI (design: pocketshell key vault,
 * section 5). Every client shows the same unlock sheet, setup, reset, change
 * passphrase, key list and host key picker; the platform injects only what
 * differs:
 *
 *   provideKeyVault({
 *     store,                       // core KeyVaultStore over its slot transport
 *     remember: { save, forget, isRemembered },  // device-key wrapping (omit: no "remember")
 *     resetUrl, openUrl,           // where "Forgot it?" goes when reset is elsewhere (Android, psc)
 *     onForgot,                    // or: an in-app reset (web)
 *     reauth,                      // a fresh account sign-in before a reset
 *     hostList,                    // reset while locked: prove or delete the synced host list
 *     canUpload: true,             // web only: add / rotate keys
 *   });
 *
 * Nothing here branches on the platform: a missing capability hides its UI.
 * With nothing provided, every vault component renders nothing.
 */
import { reactive, shallowRef } from 'vue';
import { generateSyncPassphrase, vaultPassphraseReusesSync } from '@pocketshell/core';
import type {
  GatewayAuthPolicy,
  HostKeyBinding,
  KeyVaultStore,
  VaultAddKeyResult,
  VaultChangePassphraseResult,
  VaultCreateResult,
  VaultKeyEntry,
  VaultRememberRecord,
  VaultUnlockResult,
  VaultWriteResult,
} from '@pocketshell/core';

export interface KeyVaultRememberApi {
  /** Wrap and store the record with a non-extractable device key, then wipe `record.dek`/`auth`. */
  save(record: VaultRememberRecord): Promise<void>;
  /** Delete this device's remembered record ("Forget on this device"). */
  forget(): Promise<void>;
  isRemembered(): Promise<boolean>;
}

/** Reset while the vault is locked: the synced host list is sealed with the old sync passphrase. */
export interface KeyVaultHostListApi {
  exists(): Promise<boolean>;
  /** Does this passphrase open the `main` slot? */
  verifyPassphrase(passphrase: string): Promise<boolean>;
  /** "I forgot that too": delete the synced host list. */
  remove(): Promise<void>;
}

export interface KeyVaultPlatform {
  store: KeyVaultStore;
  remember?: KeyVaultRememberApi;
  /** Adding and rotating keys (the web). Elsewhere the list is read-only. */
  canUpload?: boolean;
  /** "Forgot it?" opens this URL (Android, psc) … */
  resetUrl?: string;
  openUrl?(url: string): void | Promise<void>;
  /** … or runs an in-app reset (web). Wins over `resetUrl`. */
  onForgot?(): void;
  /** A fresh account sign-in (within 5 minutes) before a reset. Resolves false when abandoned. */
  reauth?(): Promise<boolean>;
  hostList?: KeyVaultHostListApi;
  /** Clipboard write for "Copy public key"; default navigator.clipboard. */
  copyText?(text: string): Promise<void>;
  now?(): number;
}

/** User-facing copy shared by every client. */
export const VAULT_TEXT = {
  wrongPassphrase: "That passphrase didn't unlock your vault.",
  noVault: "This account has no key vault yet. Create one on the PocketShell web app.",
  corrupt: "Your vault couldn't be read. It may have been damaged; resetting it starts a new, empty vault.",
  forgot:
    'Your vault passphrase cannot be recovered: PocketShell never sees it. Reset the vault, choose a new passphrase ' +
    'and upload your keys again. Hosts keep their key assignments, so re-uploading the same key reattaches it.',
  unrecoverable:
    "If you forget it, your keys cannot be recovered. You'll reset the vault and upload them again.",
  unsupportedVersion: 'Your vault was saved by a newer version of PocketShell. Update this app to open it.',
  reusesSync:
    'Choose a vault passphrase different from your sync passphrase: the host list is protected more cheaply, so ' +
    'sharing one passphrase would weaken your keys.',
  rememberHint:
    'Remembering keeps an encrypted vault key on this device, locked to a key only this device holds. The ' +
    'passphrase itself is never saved, and never sent to the server.',
} as const;

/** The message for a non-ok unlock result; `waitSeconds` is the live countdown. */
export function vaultUnlockMessage(result: Exclude<VaultUnlockResult, { kind: 'ok' }>, waitSeconds = 0): string {
  const wait = waitSeconds > 0 ? ` Try again in ${waitSeconds} s.` : '';
  switch (result.kind) {
    case 'wrongPassphrase':
    case 'backoff':
      return `${VAULT_TEXT.wrongPassphrase}${wait || ' Check it and try again.'}`;
    case 'rateLimited':
      return `Too many wrong passphrases on this account.${wait || ' Try again later.'}`;
    case 'noVault':
      return VAULT_TEXT.noVault;
    case 'unsupportedVersion':
      return VAULT_TEXT.unsupportedVersion;
    case 'corrupt':
      return VAULT_TEXT.corrupt;
    case 'error':
      return `Couldn't reach your vault: ${result.message}`;
  }
}

/** The message for a failed vault write (add, bind, rename, …). */
export function vaultWriteMessage(result: { kind: string; message?: string }): string {
  switch (result.kind) {
    case 'locked':
      return 'Your vault is locked. Unlock it and try again.';
    case 'gated':
      return 'Your session with the vault expired. Unlock it again.';
    case 'vaultChanged':
      return 'Your vault was reset or replaced on another device. Unlock it again.';
    case 'indexFull':
      return 'Your vault is full. Remove a key or password you no longer use.';
    case 'tooLarge':
      return 'That is too large to store in the vault.';
    case 'conflictLimit':
      return 'Another device kept changing your vault. Try again.';
    case 'exists':
      return 'This account already has a vault.';
    case 'freshAuthRequired':
      return 'Sign in again (within the last 5 minutes) to reset your vault.';
    case 'unsupportedVersion':
      return VAULT_TEXT.unsupportedVersion;
    case 'reusesSync':
      return VAULT_TEXT.reusesSync;
    case 'wrongPassphrase':
      return "That isn't your current vault passphrase.";
    case 'passphraseChangedElsewhere':
      return 'Your vault passphrase was changed on another device. Unlock with the new one first.';
    case 'invalid':
    case 'unsupported':
    case 'error':
      return result.message ?? 'Something went wrong.';
    default:
      return `Vault error: ${result.kind}`;
  }
}

// ── passphrase strength (a guide; MIN_LENGTH is the only hard floor) ─────

export const VAULT_PASSPHRASE_MIN_LENGTH = 8;

export interface PassphraseStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'too short' | 'weak' | 'fair' | 'good' | 'strong';
  bits: number;
}

/** Estimated entropy from length and character classes, discounted for repeats and runs. */
export function passphraseStrength(passphrase: string): PassphraseStrength {
  const chars = [...passphrase];
  if (chars.length < VAULT_PASSPHRASE_MIN_LENGTH) return { score: 0, label: 'too short', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/[0-9]/.test(passphrase)) pool += 10;
  if (/[^A-Za-z0-9]/.test(passphrase)) pool += 33;
  let effective = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const prev = i > 0 ? (chars[i - 1] as string).codePointAt(0)! : -10;
    const cur = (chars[i] as string).codePointAt(0)!;
    effective += Math.abs(cur - prev) <= 1 ? 0.5 : 1;
  }
  const bits = Math.round(effective * Math.log2(Math.max(pool, 2)));
  const score = bits >= 80 ? 4 : bits >= 60 ? 3 : bits >= 45 ? 2 : 1;
  return { score, label: (['too short', 'weak', 'fair', 'good', 'strong'] as const)[score], bits };
}

// ── the controller ───────────────────────────────────────────────────────

export interface KeyVaultView {
  state: 'locked' | 'unlocked';
  keys: VaultKeyEntry[];
  bindings: Record<string, HostKeyBinding>;
  /** Epoch ms before which a passphrase attempt is refused (client backoff). */
  retryAt: number;
  remembered: boolean;
}

export interface UnlockSheetState {
  open: boolean;
  /** Why: a dial waits on it, or the user asked (settings, keys page). */
  reason: 'connect' | 'account';
  /** Optional host label for the "to connect" title. */
  hostLabel: string;
  seq: number;
}

export type KeyVaultController = ReturnType<typeof createKeyVaultController>;

export function createKeyVaultController(platform: KeyVaultPlatform) {
  const store = platform.store;
  const now = platform.now ?? (() => Date.now());
  const view = reactive<KeyVaultView>({ state: 'locked', keys: [], bindings: {}, retryAt: 0, remembered: false });
  const sheet = reactive<UnlockSheetState>({ open: false, reason: 'connect', hostLabel: '', seq: 0 });
  let waiters: Array<(unlocked: boolean) => void> = [];

  function refresh(): void {
    view.state = store.state;
    view.keys = store.listKeys();
    view.bindings = store.listHostBindings();
    const remaining = store.backoffRemainingMs();
    view.retryAt = remaining > 0 ? now() + remaining : 0;
    if (store.state === 'unlocked' && sheet.open) settle(true);
  }
  store.subscribe(refresh);
  refresh();
  void platform.remember?.isRemembered().then((on) => (view.remembered = on), () => undefined);

  async function saveRemember(): Promise<void> {
    const record = store.exportRememberRecord();
    if (!record || !platform.remember) return;
    await platform.remember.save(record);
    record.dek.fill(0);
    record.auth?.fill(0);
    view.remembered = true;
  }

  function settle(unlocked: boolean): void {
    sheet.open = false;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(unlocked);
  }

  /** Decision #7: does a would-be vault passphrase reuse the sync passphrase? */
  function reusesSync(passphrase: string, syncPassphrase: string | null): Promise<boolean> {
    const opens = platform.hostList?.verifyPassphrase;
    return vaultPassphraseReusesSync(passphrase, {
      syncPassphrase,
      ...(opens ? { opensHostList: (candidate: string) => opens(candidate).catch(() => false) } : {}),
    });
  }

  return {
    platform,
    store,
    view,
    sheet,
    canRemember: platform.remember !== undefined,
    canUpload: platform.canUpload === true,
    canForgot: platform.onForgot !== undefined || (platform.resetUrl !== undefined && platform.openUrl !== undefined),

    /** Unlock with the passphrase; on success optionally remember this device. */
    async unlock(passphrase: string, remember: boolean): Promise<VaultUnlockResult> {
      const result = await store.unlock(passphrase);
      refresh();
      if (result.kind === 'ok' && remember) {
        try {
          await saveRemember();
        } catch {
          // Unlocked anyway; remembering is a convenience and the next unlock asks again.
        }
      }
      return result;
    },

    /**
     * Create the vault. `syncPassphrase` is the account's existing sync
     * passphrase when it already has a host list; without one, the account
     * gets a fresh random sync passphrase (decision #7: never the vault's).
     */
    async create(passphrase: string, remember: boolean, syncPassphrase?: string | null): Promise<VaultCreateResult | { kind: 'reusesSync' }> {
      if (await reusesSync(passphrase, syncPassphrase ?? null)) return { kind: 'reusesSync' };
      const result = await store.createVault(passphrase, { syncPassphrase: syncPassphrase || generateSyncPassphrase() });
      refresh();
      if (result.kind === 'ok' && remember) await saveRemember().catch(() => undefined);
      return result;
    },

    async changePassphrase(current: string, next: string): Promise<VaultChangePassphraseResult | { kind: 'reusesSync' }> {
      if (await reusesSync(next, store.getSyncPassphrase())) return { kind: 'reusesSync' };
      const result = await store.changePassphrase(current, next);
      refresh();
      // A remembered record keeps working (same DEK) but carries the old AUTH: refresh it.
      if (result.kind === 'ok' && view.remembered) await saveRemember().catch(() => undefined);
      return result;
    },

    /**
     * Reset (the caller has re-authenticated). `syncPassphrase`: the one to
     * keep, or 'generate' for a fresh random one (no host list, or it is
     * being deleted); undefined carries the current one.
     */
    async reset(
      newPassphrase: string,
      options: { syncPassphrase?: string | 'generate'; remember: boolean },
    ): Promise<VaultCreateResult | { kind: 'reusesSync' }> {
      const sync = options.syncPassphrase === 'generate' ? generateSyncPassphrase() : options.syncPassphrase;
      if (await reusesSync(newPassphrase, sync ?? store.getSyncPassphrase())) return { kind: 'reusesSync' };
      await platform.remember?.forget().catch(() => undefined);
      view.remembered = false;
      const result = await store.resetVault(newPassphrase, { ...(sync !== undefined ? { syncPassphrase: sync } : {}) });
      refresh();
      if (result.kind === 'ok' && options.remember) await saveRemember().catch(() => undefined);
      return result;
    },

    lock(): void {
      store.lock();
      refresh();
    },

    async rememberNow(): Promise<void> {
      await saveRemember();
    },

    async forgetDevice(): Promise<void> {
      await platform.remember?.forget();
      view.remembered = false;
    },

    addKey(pem: string, name: string, keyPassphrase?: string): Promise<VaultAddKeyResult> {
      return store.addKey(pem, name, keyPassphrase);
    },

    /** Upload a replacement for `oldKeyId`; hosts follow and the old key goes. */
    async rotateKey(oldKeyId: string, pem: string, name: string, keyPassphrase?: string): Promise<VaultAddKeyResult> {
      const added = await store.addKey(pem, name, keyPassphrase);
      if (added.kind !== 'ok') return added;
      if (added.entry.keyId === oldKeyId) return { kind: 'error', message: 'That is the same key.' };
      const rotated = await store.rotateKey(oldKeyId, added.entry.keyId);
      return rotated.kind === 'ok' ? added : rotated;
    },

    bindHost(hostAlias: string, binding: HostKeyBinding | null): Promise<VaultWriteResult> {
      return binding === null ? store.unbindHost(hostAlias) : store.bindHost(hostAlias, binding.keyId, binding.gatewayAuth);
    },

    async copyPublicKey(keyId: string): Promise<boolean> {
      const line = await store.getPublicKey(keyId);
      if (line === null) return false;
      if (platform.copyText) await platform.copyText(line);
      else await (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator?.clipboard?.writeText(line);
      return true;
    },

    forgot(): void {
      settle(false);
      if (platform.onForgot) platform.onForgot();
      else if (platform.resetUrl && platform.openUrl) void platform.openUrl(platform.resetUrl);
    },

    /**
     * Ask for the passphrase (the unlock sheet). Resolves true once the vault
     * is open, false when cancelled. Concurrent callers share one sheet; an
     * unlocked vault resolves at once.
     */
    requestUnlock(reason: 'connect' | 'account' = 'connect', hostLabel = ''): Promise<boolean> {
      if (store.state === 'unlocked') return Promise.resolve(true);
      if (!sheet.open) {
        sheet.open = true;
        sheet.reason = reason;
        sheet.hostLabel = hostLabel;
        sheet.seq += 1;
      }
      return new Promise((resolve) => waiters.push(resolve));
    },

    cancelUnlock(): void {
      settle(false);
    },

    refresh,
    now,
  };
}

const current = shallowRef<KeyVaultController | null>(null);

/** Install the platform's vault (once, next to provideApi). `null` removes it. */
export function provideKeyVault(platform: KeyVaultPlatform | null): KeyVaultController | null {
  current.value = platform ? createKeyVaultController(platform) : null;
  return current.value;
}

/** The provided vault controller, or null on a client without one. Reactive. */
export function useKeyVault(): KeyVaultController | null {
  return current.value;
}

/** The ref itself, for components that must react to a later provideKeyVault. */
export const keyVaultRef = current;

/** Shorthand for a dial: open the sheet if needed; true when the vault is unlocked. */
export function requestVaultUnlock(reason: 'connect' | 'account' = 'connect', hostLabel = ''): Promise<boolean> {
  return current.value ? current.value.requestUnlock(reason, hostLabel) : Promise.resolve(false);
}

export const GATEWAY_AUTH_CHOICES: ReadonlyArray<{ value: GatewayAuthPolicy; label: string; detail: string }> = [
  { value: 'managed', label: 'Vault key', detail: 'Through the gateway, sign in with this vault key only.' },
  { value: 'both', label: 'Vault key, then host keys', detail: "Try the vault key first, then the host's own keys." },
  { value: 'host', label: "Host's own keys", detail: "Through the gateway, use the host's own keys; no vault needed." },
];
