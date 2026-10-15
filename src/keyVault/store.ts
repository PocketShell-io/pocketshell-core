import { fromUtf8, randomBytes, toB64url, utf8, wipe, type VaultCryptoKey } from './bytes';
import {
  VAULT_HEADER_SLOT,
  VAULT_SLOT_LIMIT_BYTES,
  isId16,
  keyIdFromSlot,
  parseKdfParams,
  parseVaultHeader,
  parseVaultKeyBlob,
  serializeVaultHeader,
  serializeVaultKeyBlob,
  vaultKeySlot,
  type VaultHeader,
  type VaultKdfParams,
} from './format';
import { prepareSshPrivateKey, type PrepareSshKeyResult } from './sshKeys';
import {
  isGatewayAuthPolicy,
  type GatewayAuthPolicy,
  type HostKeyBinding,
  type VaultIndex,
  type VaultKeyEntry,
  type VaultSecret,
} from './types';
import {
  createVaultHeader,
  derivePassphraseKeys,
  importAesKey,
  newKdfParams,
  openIndex,
  openKeyBlob,
  openKeyBlobPublicKey,
  sealIndex,
  sealKeyBlob,
  unwrapDek,
  verifyCheck,
  wrapDek,
  type VaultPassphraseKeys,
} from './vaultCrypto';

/**
 * The key vault over the account's settings slots (design sections 3–5):
 * one `vault` header slot and one `vk-<keyId>` slot per key or password.
 * Every client drives the same store; the platform injects only byte moving
 * (the slot transport), the optional phase-2 server verifier, and its own
 * remember-on-device wrapping of the raw DEK.
 *
 * Writes are read-modify-write on the header with the slot version as the
 * base, re-based and retried on a 409. Plaintext keys are returned to the
 * caller on demand and never cached here.
 */

// ── injected platform effects ────────────────────────────────────────────

/**
 * `gated` = 403 vault_verify_required: in gated mode the server hides (and
 * refuses writes to) `vault` and `vk-*` until a recent `/vault/verify`.
 */
export type VaultSlotPullResult =
  | { kind: 'absent' }
  | { kind: 'ok'; version: number; data: string }
  | { kind: 'gated' };

export type VaultSlotPushResult =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'gated' }
  | { kind: 'error'; message: string };

/**
 * The settings API, slot-keyed: `GET/PUT/DELETE /settings/{slot}` and
 * `GET /settings`. `push` with `baseVersion` 0 creates; a stale base answers
 * `conflict`. `delete` of an absent slot must succeed.
 */
export interface VaultSlotTransport {
  pull(slot: string): Promise<VaultSlotPullResult>;
  push(slot: string, data: string, baseVersion: number): Promise<VaultSlotPushResult>;
  delete(slot: string): Promise<void>;
  list(): Promise<Array<{ slot: string; version: number }>>;
}

/**
 * `POST /vault/verify` (or `/cli/vault/verify`) answers, mapped from the W2
 * contract: 200 → ok; 401 wrong_passphrase → wrong; 429 too_many_attempts or
 * rate_limited → locked; 404 no_verifier → noVerifier; 404 route missing,
 * 409 verifier_stale, 503 vault_not_configured, network errors → unavailable.
 */
export type VaultVerifyResult =
  | { kind: 'ok' }
  | { kind: 'wrong'; retryAfterMs: number }
  | { kind: 'locked'; retryAfterMs: number }
  | { kind: 'noVerifier' }
  | { kind: 'unavailable' };

/**
 * `POST /vault/verifier {auth, epoch, currentAuth?}` answers: 200 → ok;
 * 409 epoch_mismatch → epochMismatch (with the server epoch); 401/403/429 →
 * refused; anything else → unavailable.
 */
export type VaultSetVerifierResult =
  | { kind: 'ok'; epoch: number }
  | { kind: 'epochMismatch'; epoch: number }
  | { kind: 'refused' }
  | { kind: 'unavailable' };

/**
 * `GET /vault/status` (or `/cli/vault/status`): 200 → ok. `kdf` is present in
 * gated mode, where the `vault` header stays hidden until a verify. 404/503
 * or network errors → unavailable.
 */
export type VaultServerStatus =
  | { kind: 'ok'; epoch: number; hasVerifier: boolean; retryAfterMs: number; kdf?: VaultKdfParams }
  | { kind: 'unavailable' };

/** `POST /vault/reset {"confirm":"RESET"}` answers: 200 → ok; 401 fresh_auth_required → freshAuthRequired. */
export type VaultServerResetResult =
  | { kind: 'ok'; epoch: number }
  | { kind: 'freshAuthRequired' }
  | { kind: 'unavailable' };

/**
 * The optional phase-2 server (pocketshell-sync `/vault/*`, see W2's
 * docs/KEY-VAULT.md). Each platform plugs in its HTTP calls; AUTH travels as
 * base64url (no padding) of the 32 bytes given here. A store without a
 * verifier, or one answering `unavailable`, falls back to the header's check
 * value and never fails an unlock because of the server.
 */
export interface VaultServerVerifier {
  /** Optional: when it returns `kdf`, unlock runs Argon2id → verify → read `vault`. */
  status?(): Promise<VaultServerStatus>;
  verify(auth: Uint8Array): Promise<VaultVerifyResult>;
  /** Set or replace the verifier. `currentAuth` proves the old passphrase on a change. */
  setVerifier(input: { auth: Uint8Array; epoch: number; currentAuth?: Uint8Array }): Promise<VaultSetVerifierResult>;
  /** Server-side atomic wipe of `vault`, `vk-*` and the verifier; bumps the epoch. */
  reset?(): Promise<VaultServerResetResult>;
}

/** Raw DEK plus the identity it belongs to; the platform wraps it with a device key. */
export interface VaultRememberRecord {
  vaultId: string;
  epoch: number;
  /** 32 raw bytes. The caller wraps it, then wipes its copy. */
  dek: Uint8Array;
  /**
   * 32 raw bytes of AUTH, wrapped by the same device key: a remembered device
   * verifies silently with it when the server gates the header.
   */
  auth?: Uint8Array;
}

export interface KeyVaultStoreOptions {
  transport: VaultSlotTransport;
  verifier?: VaultServerVerifier;
  /** Argon2id cost for vaults this store CREATES (default 64 MiB, t=3, p=1). Unlock always uses the header's. */
  kdf?: { m: number; t: number; p: number };
  /** Clock for the failure backoff (ms). */
  now?: () => number;
}

// ── results ──────────────────────────────────────────────────────────────

export type VaultProbeResult =
  | { kind: 'noVault' }
  /** A vault exists but the server hides it until a verify (gated mode). */
  | { kind: 'gated' }
  | { kind: 'vault'; vaultId: string; epoch: number }
  | { kind: 'corrupt' }
  | { kind: 'error'; message: string };

export type VaultUnlockResult =
  | { kind: 'ok' }
  /** The passphrase did not open the vault. `retryAfterMs` > 0 once the backoff starts. */
  | { kind: 'wrongPassphrase'; retryAfterMs: number }
  /** Still inside the client-side backoff; nothing was tried. */
  | { kind: 'backoff'; retryAfterMs: number }
  /** The phase-2 server refuses attempts for now. */
  | { kind: 'rateLimited'; retryAfterMs: number }
  | { kind: 'noVault' }
  | { kind: 'corrupt' }
  | { kind: 'error'; message: string };

export type VaultRememberUnlockResult =
  | { kind: 'ok' }
  /**
   * The record is for another vault or an older epoch, the DEK no longer
   * opens it, or the server rejected its AUTH (passphrase changed elsewhere):
   * delete it and ask for the passphrase.
   */
  | { kind: 'stale' }
  | { kind: 'rateLimited'; retryAfterMs: number }
  | { kind: 'noVault' }
  | { kind: 'corrupt' }
  | { kind: 'error'; message: string };

/** Failures every write can hit. */
export type VaultWriteFailure =
  | { kind: 'locked' }
  /** The server wants a fresh verify and the silent re-verify failed; unlock again. */
  | { kind: 'gated' }
  /** The vault was reset or replaced under us; the store locked itself. */
  | { kind: 'vaultChanged' }
  /** The header would exceed the 8 KB slot limit. */
  | { kind: 'indexFull' }
  | { kind: 'conflictLimit' }
  | { kind: 'error'; message: string };

export type VaultWriteResult = { kind: 'ok' } | VaultWriteFailure;

export type VaultAddKeyResult =
  | { kind: 'ok'; entry: VaultKeyEntry; deduplicated: boolean }
  | Exclude<PrepareSshKeyResult, { kind: 'ok' }>
  | { kind: 'tooLarge' }
  | VaultWriteFailure;

export type VaultAddPasswordResult = { kind: 'ok'; entry: VaultKeyEntry } | { kind: 'tooLarge' } | VaultWriteFailure;

export type VaultSecretResult =
  | VaultSecret
  | { kind: 'locked' }
  /** The host has no vault binding. */
  | { kind: 'unbound' }
  /** The binding names a key the vault no longer holds (removed, or not re-uploaded after a reset). */
  | { kind: 'missingKey'; keyId: string }
  /** The server wants a fresh verify and the silent re-verify failed; unlock again. */
  | { kind: 'gated' }
  | { kind: 'corrupt' }
  | { kind: 'error'; message: string };

export type VaultChangePassphraseResult =
  | { kind: 'ok' }
  | { kind: 'wrongPassphrase'; retryAfterMs: number }
  | { kind: 'backoff'; retryAfterMs: number }
  | VaultWriteFailure;

export type VaultCreateResult =
  | { kind: 'ok' }
  /** A vault already exists; unlock it (or reset it) instead. */
  | { kind: 'exists' }
  /** Reset only: the server wants a Google sign-in from the last 5 minutes. */
  | { kind: 'freshAuthRequired' }
  | { kind: 'indexFull' }
  | { kind: 'error'; message: string };

/** What a reset carries into the fresh vault (design: W3's reset flow). */
export interface VaultResetCarry {
  /** Host bindings to keep (re-uploading the same key reattaches by keyId). Default: the current ones when unlocked. */
  hosts?: Record<string, HostKeyBinding>;
  /** The account sync passphrase to keep. Default: the current one when unlocked. */
  syncPassphrase?: string | null;
}

export type VaultState = 'locked' | 'unlocked';

// ── backoff ──────────────────────────────────────────────────────────────

/** Free attempts before the backoff starts. */
export const VAULT_FREE_ATTEMPTS = 3;
export const VAULT_BACKOFF_CAP_MS = 30_000;

/** Delay after `failures` consecutive wrong passphrases: 0,0,1s after the 3rd, then 2s, 4s, … 30s. */
export function vaultBackoffMs(failures: number): number {
  if (failures < VAULT_FREE_ATTEMPTS) return 0;
  return Math.min(VAULT_BACKOFF_CAP_MS, 1000 * 2 ** (failures - VAULT_FREE_ATTEMPTS));
}

const CONFLICT_RETRIES = 3;
const PASSWORD_MAX_BYTES = 4096;

function byteLength(text: string): number {
  return utf8(text).length;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Unlocked {
  header: VaultHeader;
  version: number;
  dek: Uint8Array;
  /** HKDF(MK, ".../auth") for the remember record; null when unlocked from a record without one. */
  auth: Uint8Array | null;
  dekKey: VaultCryptoKey;
  index: VaultIndex;
}

export class KeyVaultStore {
  private readonly transport: VaultSlotTransport;
  private readonly verifier: VaultServerVerifier | undefined;
  private readonly kdf: { m: number; t: number; p: number } | undefined;
  private readonly now: () => number;
  private unlocked: Unlocked | null = null;
  private failures = 0;
  private blockedUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(options: KeyVaultStoreOptions) {
    this.transport = options.transport;
    this.verifier = options.verifier;
    this.kdf = options.kdf;
    this.now = options.now ?? (() => Date.now());
  }

  // ── state ──────────────────────────────────────────────────────────────

  get state(): VaultState {
    return this.unlocked ? 'unlocked' : 'locked';
  }

  get vaultId(): string | null {
    return this.unlocked?.header.vaultId ?? null;
  }

  get epoch(): number | null {
    return this.unlocked?.header.epoch ?? null;
  }

  /** Called after every state or content change (unlock, lock, any write). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Milliseconds until the next passphrase attempt is allowed (0 = now). */
  backoffRemainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Forget the DEK and index (sign-out, idle lock). */
  lock(): void {
    if (!this.unlocked) return;
    wipe(this.unlocked.dek);
    wipe(this.unlocked.auth);
    this.unlocked = null;
    this.emit();
  }

  /** Serialize every operation that reads-then-writes the header. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ── slot access (gated mode: silent re-verify) ─────────────────────────

  /**
   * Re-verify with the in-memory AUTH after a `gated` answer (the server's
   * verify window lapsed). True when the caller should retry once.
   */
  private async reverify(auth: Uint8Array | null | undefined): Promise<boolean> {
    if (!auth || !this.verifier) return false;
    return (await this.verify(Uint8Array.from(auth))).kind === 'ok';
  }

  private async pull(slot: string, auth: Uint8Array | null = this.unlocked?.auth ?? null): Promise<VaultSlotPullResult> {
    const pulled = await this.transport.pull(slot);
    if (pulled.kind !== 'gated' || !(await this.reverify(auth))) return pulled;
    return this.transport.pull(slot);
  }

  private async push(slot: string, data: string, baseVersion: number): Promise<VaultSlotPushResult> {
    const pushed = await this.transport.push(slot, data, baseVersion);
    if (pushed.kind !== 'gated' || !(await this.reverify(this.unlocked?.auth))) return pushed;
    return this.transport.push(slot, data, baseVersion);
  }

  // ── reading the header ─────────────────────────────────────────────────

  private async pullHeader(
    auth?: Uint8Array | null,
  ): Promise<{ kind: 'ok'; header: VaultHeader; version: number } | { kind: 'noVault' } | { kind: 'corrupt' } | { kind: 'gated' }> {
    const pulled = await this.pull(VAULT_HEADER_SLOT, auth === undefined ? this.unlocked?.auth ?? null : auth);
    if (pulled.kind === 'absent') return { kind: 'noVault' };
    if (pulled.kind === 'gated') return pulled;
    const header = parseVaultHeader(pulled.data);
    return header ? { kind: 'ok', header, version: pulled.version } : { kind: 'corrupt' };
  }

  /** Is there a vault on the account, without unlocking it. */
  async probe(): Promise<VaultProbeResult> {
    try {
      const pulled = await this.pullHeader();
      if (pulled.kind !== 'ok') return pulled;
      return { kind: 'vault', vaultId: pulled.header.vaultId, epoch: pulled.header.epoch };
    } catch (error) {
      return { kind: 'error', message: describe(error) };
    }
  }

  // ── create / unlock ────────────────────────────────────────────────────

  /**
   * Create the account's vault (web only, first setup). Refuses when a
   * vault header already exists. The new vault is left unlocked.
   */
  createVault(passphrase: string, carry: { syncPassphrase?: string | null } = {}): Promise<VaultCreateResult> {
    return this.exclusive(async () => {
      try {
        const existing = await this.pullHeader();
        if (existing.kind !== 'noVault') return { kind: 'exists' };
        const index: VaultIndex = { keys: [], hosts: {} };
        if (carry.syncPassphrase) index.sync = { passphrase: carry.syncPassphrase };
        return await this.writeFreshVault(passphrase, index, 1, 0);
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  private async writeFreshVault(
    passphrase: string,
    index: VaultIndex,
    epoch: number,
    baseVersion: number,
  ): Promise<VaultCreateResult> {
    const created = await createVaultHeader({ passphrase, index, epoch, ...(this.kdf ? { kdf: this.kdf } : {}) });
    const data = serializeVaultHeader(created.header);
    if (byteLength(data) > VAULT_SLOT_LIMIT_BYTES) {
      wipe(created.dek);
      return { kind: 'indexFull' };
    }
    const pushed = await this.transport.push(VAULT_HEADER_SLOT, data, baseVersion);
    if (pushed.kind !== 'ok') {
      wipe(created.dek);
      wipe(created.auth);
      // A gated answer means a hidden vault already exists.
      return pushed.kind === 'error' ? { kind: 'error', message: pushed.message } : { kind: 'exists' };
    }
    const auth = Uint8Array.from(created.auth);
    await this.publishVerifier(created.auth, epoch);
    this.lock();
    this.unlocked = {
      header: created.header,
      version: pushed.version,
      dek: created.dek,
      auth,
      dekKey: await importAesKey(created.dek),
      index,
    };
    this.failures = 0;
    this.blockedUntil = 0;
    this.emit();
    return { kind: 'ok' };
  }

  /**
   * Best-effort verifier publish (phase 2 is optional; the check value stays
   * authoritative). A server epoch that differs from the header's is
   * adopted for the one retry. Wipes `auth` and `currentAuth`.
   */
  private async publishVerifier(auth: Uint8Array, epoch: number, currentAuth?: Uint8Array): Promise<VaultSetVerifierResult> {
    try {
      if (!this.verifier) return { kind: 'unavailable' };
      const input = (at: number) => ({ auth, epoch: at, ...(currentAuth ? { currentAuth } : {}) });
      let result = await this.verifier.setVerifier(input(epoch));
      if (result.kind === 'epochMismatch') result = await this.verifier.setVerifier(input(result.epoch));
      return result;
    } catch {
      return { kind: 'unavailable' };
    } finally {
      wipe(auth);
      wipe(currentAuth);
    }
  }

  private recordFailure(): number {
    this.failures += 1;
    const delay = vaultBackoffMs(this.failures);
    this.blockedUntil = this.now() + delay;
    return delay;
  }

  /**
   * Unlock with the account vault passphrase: Argon2id → (server verify, if
   * deployed) → check value → unwrap DEK → decrypt the index. A wrong
   * passphrase is a result, never a throw.
   */
  unlock(passphrase: string): Promise<VaultUnlockResult> {
    return this.exclusive(async () => {
      const wait = this.backoffRemainingMs();
      if (wait > 0) return { kind: 'backoff', retryAfterMs: wait };
      try {
        const status = await this.serverStatus();
        if (status && status.retryAfterMs > 0) return { kind: 'rateLimited', retryAfterMs: status.retryAfterMs };
        let header: VaultHeader;
        let version: number;
        let keys: VaultPassphraseKeys;
        let verdict: VaultVerifyResult = { kind: 'unavailable' };
        if (status?.kdf) {
          // Gated mode: the header is hidden until a verify, so the server's
          // public KDF params drive Argon2id and the server's answer is final.
          keys = await derivePassphraseKeys(passphrase, status.kdf);
          verdict = await this.verify(keys.auth);
          if (verdict.kind === 'locked') {
            wipe(keys.auth);
            return { kind: 'rateLimited', retryAfterMs: Math.max(0, verdict.retryAfterMs) };
          }
          if (verdict.kind === 'wrong') {
            wipe(keys.auth);
            return { kind: 'wrongPassphrase', retryAfterMs: Math.max(this.recordFailure(), verdict.retryAfterMs) };
          }
          // Just verified, so this read is inside the server's window.
          const pulled = await this.pullHeader(null);
          if (pulled.kind !== 'ok') {
            wipe(keys.auth);
            return pulled.kind === 'gated' ? { kind: 'error', message: 'the server still hides the vault after a verify' } : pulled;
          }
          ({ header, version } = pulled);
          if (JSON.stringify(header.kdf) !== JSON.stringify(status.kdf)) {
            wipe(keys.auth);
            keys = await derivePassphraseKeys(passphrase, header.kdf);
          }
        } else {
          const pulled = await this.pullHeader(null);
          if (pulled.kind === 'gated') {
            return { kind: 'error', message: 'the server hides the vault but gave no KDF parameters (GET /vault/status)' };
          }
          if (pulled.kind !== 'ok') return pulled;
          ({ header, version } = pulled);
          keys = await derivePassphraseKeys(passphrase, header.kdf);
          verdict = await this.verify(keys.auth);
          if (verdict.kind === 'locked') {
            wipe(keys.auth);
            return { kind: 'rateLimited', retryAfterMs: Math.max(0, verdict.retryAfterMs) };
          }
        }
        const { kek, auth } = keys;
        try {
          if (!(await verifyCheck(kek, header))) {
            wipe(auth);
            const delay = this.recordFailure();
            const server = verdict.kind === 'wrong' ? Math.max(0, verdict.retryAfterMs) : 0;
            return { kind: 'wrongPassphrase', retryAfterMs: Math.max(delay, server) };
          }
          // The check value is authoritative. A server with no verifier yet gets one now;
          // one that disagrees is stale and can only be fixed with the old passphrase.
          if (verdict.kind === 'noVerifier') await this.publishVerifier(Uint8Array.from(auth), status?.epoch ?? header.epoch);
        } catch (error) {
          wipe(auth);
          throw error;
        }
        const dek = await unwrapDek(kek, header);
        const dekKey = dek ? await importAesKey(dek) : null;
        const index = dekKey ? await openIndex(dekKey, header) : null;
        if (!dek || !dekKey || !index) {
          wipe(dek);
          wipe(auth);
          return { kind: 'corrupt' };
        }
        this.lock();
        this.unlocked = { header, version, dek, dekKey, auth, index };
        this.failures = 0;
        this.blockedUntil = 0;
        this.emit();
        return { kind: 'ok' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  private async serverStatus(): Promise<Extract<VaultServerStatus, { kind: 'ok' }> | null> {
    if (!this.verifier?.status) return null;
    const status = await this.verifier.status().catch((): VaultServerStatus => ({ kind: 'unavailable' }));
    if (status.kind !== 'ok') return null;
    const kdf = status.kdf === undefined || status.kdf === null ? undefined : parseKdfParams(status.kdf) ?? undefined;
    return { ...status, retryAfterMs: Math.max(0, status.retryAfterMs || 0), ...(kdf ? { kdf } : {}) };
  }

  private async verify(auth: Uint8Array): Promise<VaultVerifyResult> {
    if (!this.verifier) return { kind: 'unavailable' };
    return this.verifier.verify(auth).catch((): VaultVerifyResult => ({ kind: 'unavailable' }));
  }

  /** A copy of the raw DEK for the platform to wrap with its device key; null when locked. */
  exportRememberRecord(): VaultRememberRecord | null {
    if (!this.unlocked) return null;
    return {
      vaultId: this.unlocked.header.vaultId,
      epoch: this.unlocked.header.epoch,
      dek: Uint8Array.from(this.unlocked.dek),
      ...(this.unlocked.auth ? { auth: Uint8Array.from(this.unlocked.auth) } : {}),
    };
  }

  /** Unlock from a remembered DEK (no passphrase, no Argon2id). */
  unlockWithRememberedDek(record: VaultRememberRecord): Promise<VaultRememberUnlockResult> {
    return this.exclusive(async () => {
      try {
        if (!record || !(record.dek instanceof Uint8Array) || record.dek.length !== 32) return { kind: 'stale' };
        const hasAuth = record.auth instanceof Uint8Array && record.auth.length === 32;
        const status = await this.serverStatus();
        if (status?.kdf) {
          // Gated: the header is only readable after a verify.
          if (!hasAuth) return { kind: 'stale' };
          if (status.retryAfterMs > 0) return { kind: 'rateLimited', retryAfterMs: status.retryAfterMs };
          const verdict = await this.verify(Uint8Array.from(record.auth as Uint8Array));
          if (verdict.kind === 'locked') return { kind: 'rateLimited', retryAfterMs: Math.max(0, verdict.retryAfterMs) };
          // A remembered AUTH the server rejects means the passphrase changed elsewhere.
          if (verdict.kind === 'wrong') return { kind: 'stale' };
        }
        const pulled = await this.pullHeader(hasAuth ? (record.auth as Uint8Array) : null);
        if (pulled.kind === 'gated') return { kind: 'stale' };
        if (pulled.kind !== 'ok') return pulled;
        const { header, version } = pulled;
        if (header.vaultId !== record.vaultId || header.epoch !== record.epoch) return { kind: 'stale' };
        const dek = Uint8Array.from(record.dek);
        const dekKey = await importAesKey(dek);
        const index = await openIndex(dekKey, header);
        if (!index) {
          wipe(dek);
          return { kind: 'stale' };
        }
        this.lock();
        this.unlocked = { header, version, dek, dekKey, auth: hasAuth ? Uint8Array.from(record.auth as Uint8Array) : null, index };
        this.emit();
        return { kind: 'ok' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  // ── reading the index ──────────────────────────────────────────────────

  listKeys(): VaultKeyEntry[] {
    return this.unlocked ? this.unlocked.index.keys.map((entry) => ({ ...entry })) : [];
  }

  getKey(keyId: string): VaultKeyEntry | null {
    const entry = this.unlocked?.index.keys.find((key) => key.keyId === keyId);
    return entry ? { ...entry } : null;
  }

  /** The binding for an account host alias (the `main` payload host name). */
  getHostBinding(hostAlias: string): HostKeyBinding | null {
    const binding = this.unlocked && Object.prototype.hasOwnProperty.call(this.unlocked.index.hosts, hostAlias)
      ? this.unlocked.index.hosts[hostAlias]
      : undefined;
    return binding ? { ...binding } : null;
  }

  listHostBindings(): Record<string, HostKeyBinding> {
    const out: Record<string, HostKeyBinding> = {};
    for (const [alias, binding] of Object.entries(this.unlocked?.index.hosts ?? {})) out[alias] = { ...binding };
    return out;
  }

  /** The account settings-sync passphrase kept in the vault, so one unlock opens `main` too. */
  getSyncPassphrase(): string | null {
    return this.unlocked?.index.sync?.passphrase ?? null;
  }

  // ── secrets ────────────────────────────────────────────────────────────

  /** Decrypt the credential bound to a host. Plaintext is the caller's to use and drop. */
  async decryptKeyForHost(hostAlias: string): Promise<VaultSecretResult> {
    if (!this.unlocked) return { kind: 'locked' };
    const binding = this.getHostBinding(hostAlias);
    if (!binding) return { kind: 'unbound' };
    return this.decryptKey(binding.keyId);
  }

  /** Decrypt one vault entry by keyId. */
  async decryptKey(keyId: string): Promise<VaultSecretResult> {
    const unlocked = this.unlocked;
    if (!unlocked) return { kind: 'locked' };
    const entry = unlocked.index.keys.find((key) => key.keyId === keyId);
    if (!entry) return { kind: 'missingKey', keyId };
    try {
      const pulled = await this.pull(vaultKeySlot(keyId));
      if (pulled.kind === 'gated') return { kind: 'gated' };
      if (pulled.kind === 'absent') return { kind: 'missingKey', keyId };
      const blob = parseVaultKeyBlob(pulled.data, { vaultId: unlocked.header.vaultId, keyId });
      if (!blob) return { kind: 'corrupt' };
      const pt = await openKeyBlob(unlocked.dekKey, blob);
      if (!pt) return { kind: 'corrupt' };
      try {
        const text = fromUtf8(pt);
        return entry.type === 'password' ? { kind: 'password', password: text } : { kind: 'key', pem: text };
      } finally {
        wipe(pt);
      }
    } catch (error) {
      return { kind: 'error', message: describe(error) };
    }
  }

  /** The OpenSSH public key line of a vault key (no private key is decrypted); null for passwords or when unavailable. */
  async getPublicKey(keyId: string): Promise<string | null> {
    const unlocked = this.unlocked;
    if (!unlocked || !isId16(keyId)) return null;
    try {
      const pulled = await this.pull(vaultKeySlot(keyId));
      if (pulled.kind !== 'ok') return null;
      const blob = parseVaultKeyBlob(pulled.data, { vaultId: unlocked.header.vaultId, keyId });
      return blob ? await openKeyBlobPublicKey(unlocked.dekKey, blob) : null;
    } catch {
      return null;
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────

  /**
   * Re-seal the index after `mutate`, pushed on the header version we hold;
   * on a 409, re-pull, re-open (same vault and epoch only), re-apply, retry.
   * `mutate` returns false to abort without writing.
   */
  private async writeIndex(mutate: (index: VaultIndex) => boolean | VaultWriteFailure): Promise<VaultWriteResult> {
    let state = this.unlocked;
    if (!state) return { kind: 'locked' };
    for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
      const index: VaultIndex = JSON.parse(JSON.stringify(state.index)) as VaultIndex;
      const verdict = mutate(index);
      if (verdict === false) return { kind: 'ok' };
      if (verdict !== true) return verdict;
      const header: VaultHeader = {
        ...state.header,
        index: await sealIndex(state.dekKey, state.header.vaultId, index),
        updatedAt: new Date(this.now()).toISOString(),
      };
      const data = serializeVaultHeader(header);
      if (byteLength(data) > VAULT_SLOT_LIMIT_BYTES) return { kind: 'indexFull' };
      let pushed: VaultSlotPushResult;
      try {
        pushed = await this.push(VAULT_HEADER_SLOT, data, state.version);
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
      if (pushed.kind === 'error') return { kind: 'error', message: pushed.message };
      if (pushed.kind === 'gated') return { kind: 'gated' };
      if (pushed.kind === 'ok') {
        state.header = header;
        state.version = pushed.version;
        state.index = index;
        this.emit();
        return { kind: 'ok' };
      }
      const rebased = await this.rebase(state);
      if (rebased.kind !== 'ok') return rebased;
      state = this.unlocked as Unlocked;
    }
    return { kind: 'conflictLimit' };
  }

  /** Re-pull the header after a conflict and re-open it with the DEK we hold. */
  private async rebase(state: Unlocked): Promise<{ kind: 'ok' } | VaultWriteFailure> {
    let pulled;
    try {
      pulled = await this.pullHeader();
    } catch (error) {
      return { kind: 'error', message: describe(error) };
    }
    if (pulled.kind === 'gated') return { kind: 'gated' };
    if (pulled.kind !== 'ok' || pulled.header.vaultId !== state.header.vaultId || pulled.header.epoch !== state.header.epoch) {
      this.lock();
      return { kind: 'vaultChanged' };
    }
    const index = await openIndex(state.dekKey, pulled.header);
    if (!index) {
      this.lock();
      return { kind: 'vaultChanged' };
    }
    state.header = pulled.header;
    state.version = pulled.version;
    state.index = index;
    return { kind: 'ok' };
  }

  /** Write a `vk-` slot (create, or overwrite whatever is there). */
  private async writeBlob(keyId: string, data: string): Promise<{ kind: 'ok' } | { kind: 'gated' } | { kind: 'error'; message: string }> {
    const slot = vaultKeySlot(keyId);
    let base = 0;
    for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
      try {
        const pushed = await this.push(slot, data, base);
        if (pushed.kind === 'ok') return { kind: 'ok' };
        if (pushed.kind === 'gated') return { kind: 'gated' };
        if (pushed.kind === 'error') return { kind: 'error', message: pushed.message };
        base = pushed.currentVersion;
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    }
    return { kind: 'error', message: `could not write ${slot}: too many conflicts` };
  }

  /**
   * Add an SSH private key (web upload). An encrypted key needs
   * `keyPassphrase`; the vault stores the decrypted PEM. The same key
   * uploaded twice deduplicates by its content-derived keyId (the name is
   * kept from the first upload).
   */
  addKey(pem: string, name: string, keyPassphrase?: string | null): Promise<VaultAddKeyResult> {
    return this.exclusive(async () => {
      const unlocked = this.unlocked;
      if (!unlocked) return { kind: 'locked' };
      const prepared = await prepareSshPrivateKey(pem, keyPassphrase);
      if (prepared.kind !== 'ok') return prepared;
      const key = prepared.key;
      const plaintext = utf8(key.pem);
      let blobData: string;
      try {
        blobData = serializeVaultKeyBlob(
          await sealKeyBlob(unlocked.dekKey, unlocked.header.vaultId, key.keyId, plaintext, key.publicKey),
        );
      } finally {
        wipe(plaintext);
      }
      if (byteLength(blobData) > VAULT_SLOT_LIMIT_BYTES) return { kind: 'tooLarge' };
      const wrote = await this.writeBlob(key.keyId, blobData);
      if (wrote.kind !== 'ok') return wrote;
      const existed = unlocked.index.keys.some((entry) => entry.keyId === key.keyId);
      const entry: VaultKeyEntry = {
        keyId: key.keyId,
        name: name.trim() || key.type,
        type: key.type,
        fingerprint: key.fingerprint,
        createdAt: new Date(this.now()).toISOString(),
      };
      const result = await this.writeIndex((index) => {
        if (index.keys.some((existing) => existing.keyId === entry.keyId)) return false;
        index.keys.push(entry);
        return true;
      });
      if (result.kind !== 'ok') {
        if (!existed) await this.transport.delete(vaultKeySlot(key.keyId)).catch(() => undefined);
        return result;
      }
      return { kind: 'ok', entry: this.getKey(key.keyId) ?? entry, deduplicated: existed };
    });
  }

  /** Add a host password as a vault entry (random keyId). */
  addPassword(password: string, name: string): Promise<VaultAddPasswordResult> {
    return this.exclusive(async () => {
      const unlocked = this.unlocked;
      if (!unlocked) return { kind: 'locked' };
      const plaintext = utf8(password);
      if (plaintext.length === 0 || plaintext.length > PASSWORD_MAX_BYTES) {
        wipe(plaintext);
        return { kind: 'tooLarge' };
      }
      const keyId = toB64url(randomBytes(16));
      let blobData: string;
      try {
        blobData = serializeVaultKeyBlob(await sealKeyBlob(unlocked.dekKey, unlocked.header.vaultId, keyId, plaintext));
      } finally {
        wipe(plaintext);
      }
      const wrote = await this.writeBlob(keyId, blobData);
      if (wrote.kind !== 'ok') return wrote;
      const entry: VaultKeyEntry = {
        keyId,
        name: name.trim() || 'Password',
        type: 'password',
        createdAt: new Date(this.now()).toISOString(),
      };
      const result = await this.writeIndex((index) => {
        index.keys.push(entry);
        return true;
      });
      if (result.kind !== 'ok') {
        await this.transport.delete(vaultKeySlot(keyId)).catch(() => undefined);
        return result;
      }
      return { kind: 'ok', entry };
    });
  }

  /**
   * Remove a key or password: index first, then its slot. Host bindings
   * that name it are kept (they show as `missingKey` until the same key is
   * uploaded again or the host is rebound).
   */
  removeKey(keyId: string): Promise<VaultWriteResult> {
    return this.exclusive(async () => {
      const result = await this.writeIndex((index) => {
        const before = index.keys.length;
        index.keys = index.keys.filter((entry) => entry.keyId !== keyId);
        return index.keys.length !== before;
      });
      if (result.kind === 'ok' && isId16(keyId)) {
        try {
          await this.transport.delete(vaultKeySlot(keyId));
        } catch {
          // An orphaned blob is unreadable without the index entry's type and harmless.
        }
      }
      return result;
    });
  }

  renameKey(keyId: string, name: string): Promise<VaultWriteResult> {
    return this.exclusive(() =>
      this.writeIndex((index) => {
        const entry = index.keys.find((key) => key.keyId === keyId);
        const trimmed = name.trim();
        if (!entry || trimmed === '' || entry.name === trimmed) return false;
        entry.name = trimmed;
        return true;
      }),
    );
  }

  /** Record that `newKeyId` replaces `oldKeyId`: rebind its hosts and drop the old key. */
  rotateKey(oldKeyId: string, newKeyId: string): Promise<VaultWriteResult> {
    return this.exclusive(async () => {
      const result = await this.writeIndex((index) => {
        const next = index.keys.find((key) => key.keyId === newKeyId);
        if (!next || oldKeyId === newKeyId) return { kind: 'error', message: 'unknown replacement key' };
        next.rotatedFrom = oldKeyId;
        index.keys = index.keys.filter((key) => key.keyId !== oldKeyId);
        for (const binding of Object.values(index.hosts)) {
          if (binding.keyId === oldKeyId) binding.keyId = newKeyId;
        }
        return true;
      });
      if (result.kind === 'ok' && isId16(oldKeyId)) await this.transport.delete(vaultKeySlot(oldKeyId)).catch(() => undefined);
      return result;
    });
  }

  /** Bind an account host alias to a vault entry with a gateway auth policy. */
  bindHost(hostAlias: string, keyId: string, gatewayAuth: GatewayAuthPolicy): Promise<VaultWriteResult> {
    return this.exclusive(() =>
      this.writeIndex((index) => {
        if (hostAlias === '' || hostAlias === '__proto__' || !isGatewayAuthPolicy(gatewayAuth)) {
          return { kind: 'error', message: 'invalid host binding' };
        }
        if (!index.keys.some((key) => key.keyId === keyId)) return { kind: 'error', message: 'unknown vault key' };
        const current = Object.prototype.hasOwnProperty.call(index.hosts, hostAlias) ? index.hosts[hostAlias] : undefined;
        if (current && current.keyId === keyId && current.gatewayAuth === gatewayAuth) return false;
        index.hosts[hostAlias] = { keyId, gatewayAuth };
        return true;
      }),
    );
  }

  unbindHost(hostAlias: string): Promise<VaultWriteResult> {
    return this.exclusive(() =>
      this.writeIndex((index) => {
        if (!Object.prototype.hasOwnProperty.call(index.hosts, hostAlias)) return false;
        delete index.hosts[hostAlias];
        return true;
      }),
    );
  }

  /** Store (or clear, with null) the account settings-sync passphrase in the index. */
  setSyncPassphrase(passphrase: string | null): Promise<VaultWriteResult> {
    return this.exclusive(() =>
      this.writeIndex((index) => {
        if ((index.sync?.passphrase ?? null) === passphrase) return false;
        if (passphrase === null) delete index.sync;
        else index.sync = { passphrase };
        return true;
      }),
    );
  }

  /**
   * Change the vault passphrase: verify the current one, then a new salt,
   * KEK, wrapped DEK and check value in one header write. Key blobs and
   * other devices' remembered DEKs keep working.
   */
  changePassphrase(current: string, next: string): Promise<VaultChangePassphraseResult> {
    return this.exclusive(async () => {
      const state = this.unlocked;
      if (!state) return { kind: 'locked' };
      const wait = this.backoffRemainingMs();
      if (wait > 0) return { kind: 'backoff', retryAfterMs: wait };
      try {
        const old = await derivePassphraseKeys(current, state.header.kdf);
        if (!(await verifyCheck(old.kek, state.header))) {
          wipe(old.auth);
          return { kind: 'wrongPassphrase', retryAfterMs: this.recordFailure() };
        }
        this.failures = 0;
        const kdf = newKdfParams(this.kdf ?? { m: state.header.kdf.m, t: state.header.kdf.t, p: state.header.kdf.p });
        const fresh = await derivePassphraseKeys(next, kdf);
        const wrapped = await wrapDek(fresh.kek, state.dek, state.header.vaultId);
        // W2 order: header first (written inside the old AUTH's verify
        // window), then the verifier with the old AUTH as proof.
        const freshAuth = Uint8Array.from(fresh.auth);
        const dropAuths = () => {
          wipe(fresh.auth);
          wipe(old.auth);
          wipe(freshAuth);
        };
        for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
          const header: VaultHeader = { ...state.header, kdf, ...wrapped, updatedAt: new Date(this.now()).toISOString() };
          const pushed = await this.push(VAULT_HEADER_SLOT, serializeVaultHeader(header), state.version);
          if (pushed.kind === 'error' || pushed.kind === 'gated') {
            dropAuths();
            return pushed.kind === 'gated' ? { kind: 'gated' } : { kind: 'error', message: pushed.message };
          }
          if (pushed.kind === 'ok') {
            state.header = header;
            state.version = pushed.version;
            await this.publishVerifier(fresh.auth, state.header.epoch, old.auth);
            wipe(state.auth);
            state.auth = freshAuth;
            this.emit();
            return { kind: 'ok' };
          }
          const rebased = await this.rebase(state);
          if (rebased.kind !== 'ok') {
            dropAuths();
            return rebased;
          }
        }
        dropAuths();
        return { kind: 'conflictLimit' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  /**
   * Reset a forgotten vault: delete every `vk-` slot, then replace the
   * header with a fresh vault (new vaultId, salt, DEK) at epoch + 1 under
   * `newPassphrase`. The CALLER re-authenticates the account first (design
   * section 5). Host bindings and the sync passphrase are carried per
   * `carry` (default: the current ones when unlocked, else none). Remembered
   * DEKs on every device become stale by epoch.
   */
  resetVault(newPassphrase: string, carry: VaultResetCarry = {}): Promise<VaultCreateResult> {
    return this.exclusive(async () => {
      try {
        const current = this.unlocked;
        const index: VaultIndex = {
          keys: [],
          hosts: carry.hosts ?? (current ? JSON.parse(JSON.stringify(current.index.hosts)) : {}),
        };
        const sync = carry.syncPassphrase !== undefined ? carry.syncPassphrase : current?.index.sync?.passphrase ?? null;
        if (sync) index.sync = { passphrase: sync };

        let serverEpoch: number | null = null;
        if (this.verifier?.reset) {
          const wiped = await this.verifier.reset().catch((): VaultServerResetResult => ({ kind: 'unavailable' }));
          if (wiped.kind === 'freshAuthRequired') return { kind: 'freshAuthRequired' };
          if (wiped.kind === 'ok') serverEpoch = wiped.epoch;
        }
        // Without the server (phase 1) the client wipes slot by slot; after a
        // server reset this finds nothing left to delete.
        const slots = await this.transport.list();
        for (const { slot } of slots) {
          if (keyIdFromSlot(slot) !== null) await this.transport.delete(slot);
        }
        let epoch = serverEpoch ?? 1;
        let base = 0;
        for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
          const pulled = await this.pull(VAULT_HEADER_SLOT);
          if (pulled.kind === 'gated') {
            return { kind: 'error', message: 'the server hides the vault; reset it through the server (POST /vault/reset)' };
          }
          if (pulled.kind === 'ok') {
            base = pulled.version;
            const old = parseVaultHeader(pulled.data);
            // A corrupt header still has to go; its epoch is unknown, so jump past any plausible one.
            epoch = Math.max(epoch, old ? old.epoch + 1 : Math.floor(this.now() / 1000));
          }
          const written = await this.writeFreshVault(newPassphrase, index, epoch, base);
          if (written.kind !== 'exists') return written;
        }
        return { kind: 'error', message: 'the vault kept changing during reset; try again' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }
}
