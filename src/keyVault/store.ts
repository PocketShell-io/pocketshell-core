import { bytesEqual, fromUtf8, randomBytes, toB64url, utf8, wipe, type VaultCryptoKey } from './bytes';
import {
  VAULT_HEADER_SLOT,
  VAULT_SLOT_LIMIT_BYTES,
  isId16,
  keyIdFromSlot,
  parseKdfParams,
  parseVaultHeader,
  parseVaultIndex,
  parseVaultKeyBlob,
  serializeVaultIndex,
  vaultFormatVersionOf,
  clampVaultName,
  serializeVaultHeader,
  serializeVaultKeyBlob,
  vaultKeySlot,
  type VaultHeader,
  type VaultKdfParams,
} from './format';
import { prepareSshPrivateKey, type PrepareSshKeyResult } from './sshKeys';
import { trustedHostSlot, parseTrustedHostEnvelope, openTrustedHost, sealTrustedHost, type TrustedHostTarget, type TrustedHostData, type TrustedHostRecord } from './trustedHosts';
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
  /** Stable, opaque account/storage namespace. Account-switching adapters
   * expose the selected scope and preserve it in scoped() snapshots. A fixed
   * single-account transport can omit it: its own identity is the scope. */
  readonly scope?: object;
  /** Snapshot the current account context before asynchronous creation/KDF work. */
  scoped?(): VaultSlotTransport;
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
  scoped?(): VaultServerVerifier;
  /** Optional atomic first setup: encrypted header and verifier are committed together, never replacing an existing vault. */
  initialize?(input: { data: string; auth: Uint8Array; epoch: number }): Promise<VaultSlotPushResult>;
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
  /** A newer vault format than this build reads: update the app (never reset over it). */
  | { kind: 'unsupportedVersion' }
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
  /** A newer vault format than this build reads: update the app (never reset over it). */
  | { kind: 'unsupportedVersion' }
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
  | { kind: 'unsupportedVersion' }
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
  /**
   * Changed. `verifierPending`: the phase-2 server verifier could not be
   * updated yet; the store keeps the proof in memory and retries on the next
   * unlock or {@link KeyVaultStore.retryVerifierPublish}. Platforms that
   * remember the vault must re-export the remember record after a change
   * (its AUTH changed).
   */
  | { kind: 'ok'; verifierPending?: true }
  | { kind: 'wrongPassphrase'; retryAfterMs: number }
  /** Another device changed the passphrase meanwhile; nothing was written. Unlock again. */
  | { kind: 'passphraseChangedElsewhere' }
  | { kind: 'backoff'; retryAfterMs: number }
  | VaultWriteFailure;

export type VaultCreateResult =
  | { kind: 'ok' }
  /** A vault already exists; unlock it (or reset it) instead. */
  | { kind: 'exists' }
  /** Reset only: the server wants a Google sign-in from the last 5 minutes. */
  | { kind: 'freshAuthRequired' }
  /** Reset only: the vault is a newer format than this build; nothing was wiped. Update the app. */
  | { kind: 'unsupportedVersion' }
  | { kind: 'indexFull' }
  | { kind: 'error'; message: string };

/** What a reset carries into the fresh vault (design: W3's reset flow). */
export interface VaultResetCarry {
  /** Host bindings to keep (re-uploading the same key reattaches by keyId). Default: the current ones when unlocked. */
  hosts?: Record<string, HostKeyBinding>;
  /** The account sync passphrase to keep. Default: the current one when unlocked. */
  syncPassphrase?: string | null;
  /**
   * Reset even a vault written by a NEWER format than this build reads.
   * Never set by a UI: an older client must not wipe a newer vault.
   */
  forceUnsupported?: boolean;
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

/** The index survives serialize → parse unchanged in shape: what every other device will read. */
function indexRoundTrips(index: VaultIndex): boolean {
  try {
    return parseVaultIndex(serializeVaultIndex(index)) !== null;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Unlocked {
  scope: object;
  header: VaultHeader;
  version: number;
  dek: Uint8Array;
  /** HKDF(MK, ".../auth") for the remember record; null when unlocked from a record without one. */
  auth: Uint8Array | null;
  dekKey: VaultCryptoKey;
  index: VaultIndex;
  /** A replay cannot replace accepted data or authorize another write in this
   * session. Keep the accepted index readable until an explicit re-unlock. */
  revisionRejected?: boolean;
}
interface ScopedIo {
  scope: object;
  generation: number;
  transport: VaultSlotTransport;
  verifier: VaultServerVerifier | undefined;
}
interface MutationContext extends ScopedIo {
  state: Unlocked | null;
  active?: () => Promise<boolean>;
}
interface RevisionFloor {
  epoch: number;
  version: number;
  /** Canonical encrypted header, never a DEK, AUTH or decrypted index. */
  header: string;
}
interface AccountRevisionFloors {
  epoch: number;
  activeVaultId: string;
  vaults: Map<string, RevisionFloor>;
}
interface AdditionBinding {
  hostAlias: string;
  gatewayAuth: GatewayAuthPolicy;
}
type TrustedHostRead = { kind: 'ok'; host: TrustedHostRecord } | { kind: 'locked' | 'absent' | 'gated' | 'invalid' | 'rollback' };

export class KeyVaultStore {
  private readonly transport: VaultSlotTransport;
  private readonly verifier: VaultServerVerifier | undefined;
  private readonly kdf: { m: number; t: number; p: number } | undefined;
  private readonly now: () => number;
  private unlocked: Unlocked | null = null;
  /** Non-secret freshness knowledge outlives lock()/drop(). It belongs to
   * the account I/O namespace, not the lifetime of a decrypted session. */
  private readonly revisionFloors = new WeakMap<object, AccountRevisionFloors>();
  /**
   * Bumped by every lock(). An operation captures it when it starts and
   * neither installs an unlocked state nor writes after it changed, so a lock
   * always wins over in-flight work.
   */
  private generation = 0;
  /**
   * A verifier update the server has not accepted yet (new AUTH, proof = old
   * AUTH), retried by retryVerifierPublish() and wiped by lock().
   *
   * Known gaps, to close BEFORE the server's gated mode is turned on:
   *  - it lives only in memory: if the app dies (or locks) before the retry
   *    succeeds, the server keeps the old verifier and other devices in gated
   *    mode are refused with the new passphrase;
   *  - gated unlock answers wrongPassphrase from the server's verdict before
   *    the repair below can run (the header is hidden, so there is no local
   *    check to prove the new passphrase);
   *  - a durable fix needs the server to accept the new verifier atomically
   *    with the header write (or a persisted, wrapped pending proof).
   */
  private pendingVerifier: { auth: Uint8Array; currentAuth: Uint8Array; epoch: number; scope: object } | null = null;
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

  /** Account clients must bind both slot and verifier IO before an upload can
   * outlive an asynchronous passphrase check. Read-only clients need neither. */
  get supportsScopedMutations(): boolean {
    return typeof this.transport.scoped === 'function' && (!this.verifier || typeof this.verifier.scoped === 'function');
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

  /** Forget the DEK and index (sign-out, idle lock). Wins over any operation in flight. */
  lock(): void {
    this.generation += 1;
    // A pending verifier proof (old + new AUTH) must not outlive the session.
    this.setPendingVerifier(null);
    if (!this.unlocked) return;
    this.drop();
    this.emit();
  }

  private drop(): void {
    if (!this.unlocked) return;
    wipe(this.unlocked.dek);
    wipe(this.unlocked.auth);
    this.unlocked = null;
  }

  /** Install a freshly opened vault unless a lock() happened since `generation`. */
  private install(generation: number, next: Unlocked): boolean {
    if (generation !== this.generation || next.scope !== this.currentScope()
      || !this.acceptsKnownRevision(next.scope,next.header,next.version)) {
      wipe(next.dek);
      wipe(next.auth);
      return false;
    }
    this.rememberRevision(next.scope,next.header,next.version);
    this.drop();
    this.unlocked = next;
    return true;
  }

  /** Serialize every operation that reads-then-writes the header. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private currentScope(): object {
    return this.transport.scope ?? this.transport;
  }

  private scopedIo(): ScopedIo {
    return { scope:this.currentScope(), generation:this.generation,
      transport: this.transport.scoped?.() ?? this.transport,
      verifier: this.verifier?.scoped?.() ?? this.verifier };
  }

  private ownsIo(io: ScopedIo): boolean {
    return io.scope === this.currentScope() && io.generation === this.generation;
  }

  private mutationContext(active?: () => Promise<boolean>): MutationContext {
    return {...this.scopedIo(),state:this.unlocked,active};
  }

  private async ownsMutation(context: MutationContext): Promise<boolean> {
    const current = () => context.state !== null && !context.state.revisionRejected && context.state.scope === context.scope && this.unlocked === context.state && this.ownsIo(context);
    return current() && (!context.active || await context.active()) && current();
  }

  private async verifyMutation(context: ScopedIo, auth: Uint8Array): Promise<VaultVerifyResult> {
    if (!context.verifier) return {kind:'unavailable'};
    const proof = Uint8Array.from(auth);
    try {return await context.verifier.verify(proof);} finally {wipe(proof);}
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

  private async pull(slot: string, auth: Uint8Array | null = this.unlocked?.auth ?? null, context?: MutationContext): Promise<VaultSlotPullResult> {
    const transport = context?.transport ?? this.transport;
    if (context && !await this.ownsMutation(context)) throw new Error('The vault operation was cancelled.');
    const pulled = await transport.pull(slot);
    if (pulled.kind !== 'gated') return pulled;
    if (context) {
      if (!auth || !context.verifier || !await this.ownsMutation(context)) return pulled;
      if ((await this.verifyMutation(context,auth)).kind !== 'ok' || !await this.ownsMutation(context)) return pulled;
    } else if (!await this.reverify(auth)) return pulled;
    return transport.pull(slot);
  }

  private async push(slot: string, data: string, baseVersion: number, context?: MutationContext): Promise<VaultSlotPushResult> {
    const transport = context?.transport ?? this.transport;
    if (context && !await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
    const pushed = await transport.push(slot, data, baseVersion);
    if (pushed.kind !== 'gated') return pushed;
    if (context) {
      const auth = context.state?.auth;
      if (!auth || !context.verifier || !await this.ownsMutation(context)) return pushed;
      if ((await this.verifyMutation(context,auth)).kind !== 'ok' || !await this.ownsMutation(context)) return pushed;
    } else if (!await this.reverify(this.unlocked?.auth)) return pushed;
    return transport.push(slot, data, baseVersion);
  }

  // ── reading the header ─────────────────────────────────────────────────

  private acceptsKnownRevision(scope: object, header: VaultHeader, version: number): boolean {
    if (!Number.isSafeInteger(version) || version < 1) return false;
    const account = this.revisionFloors.get(scope);
    if (!account) return true;
    if (header.epoch < account.epoch) return false;
    const floor = account.vaults.get(header.vaultId);
    // Reset creates a new vaultId. A known identity cannot acquire a new
    // epoch merely by changing unauthenticated transport/header metadata.
    if (floor && header.epoch !== floor.epoch) return false;
    if (header.epoch === account.epoch && floor && header.vaultId !== account.activeVaultId) return false;
    return !floor || (version >= floor.version
      && (version !== floor.version || serializeVaultHeader(header) === floor.header));
  }

  private rememberRevision(scope: object, header: VaultHeader, version: number): void {
    const account = this.revisionFloors.get(scope) ?? {epoch:header.epoch,activeVaultId:header.vaultId,vaults:new Map<string,RevisionFloor>()};
    account.epoch = header.epoch;
    account.activeVaultId = header.vaultId;
    account.vaults.set(header.vaultId,{epoch:header.epoch,version,header:serializeVaultHeader(header)});
    this.revisionFloors.set(scope,account);
  }

  /** AEAD authenticates content, not the transport's revision. An accepted
   * revision is a floor, and one revision must identify exactly one header.
   * Never lower that floor or replace its content on conflict/direct retries. */
  private acceptsHeaderRevision(state: Unlocked, header: VaultHeader, version: number): boolean {
    if (state.revisionRejected) return false;
    if (!this.acceptsKnownRevision(state.scope,header,version) || version < state.version
      || (version === state.version && serializeVaultHeader(header) !== serializeVaultHeader(state.header))) {
      state.revisionRejected = true;
      return false;
    }
    return true;
  }

  private async pullHeader(
    auth?: Uint8Array | null,
    context?: MutationContext,
    io?: ScopedIo,
  ): Promise<
    | { kind: 'ok'; header: VaultHeader; version: number }
    | { kind: 'noVault' }
    | { kind: 'unsupportedVersion' }
    | { kind: 'corrupt' }
    | { kind: 'gated' }
  > {
    const proof = auth === undefined ? this.unlocked?.auth ?? null : auth;
    let pulled: VaultSlotPullResult;
    if (io) {
      if (!this.ownsIo(io)) throw new Error('The vault account or lock state changed.');
      pulled = await io.transport.pull(VAULT_HEADER_SLOT);
      if (!this.ownsIo(io)) throw new Error('The vault account or lock state changed.');
      if (pulled.kind === 'gated' && proof && (await this.verifyMutation(io,proof)).kind === 'ok') {
        if (!this.ownsIo(io)) throw new Error('The vault account or lock state changed.');
        pulled = await io.transport.pull(VAULT_HEADER_SLOT);
      }
      if (!this.ownsIo(io)) throw new Error('The vault account or lock state changed.');
    } else pulled = await this.pull(VAULT_HEADER_SLOT,proof,context);
    if (pulled.kind === 'absent') return { kind: 'noVault' };
    if (pulled.kind === 'gated') return pulled;
    const header = parseVaultHeader(pulled.data);
    if (header) return { kind: 'ok', header, version: pulled.version };
    const version = vaultFormatVersionOf(pulled.data);
    return version !== null && version > 1 ? { kind: 'unsupportedVersion' } : { kind: 'corrupt' };
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
    // Read at CALL time: a lock() in the same tick must win over the queued task.
    const generation = this.generation;
    const io = this.scopedIo();
    const {transport,verifier} = io;
    return this.exclusive(async () => {
      try {
        if (io.scope !== this.currentScope()) return {kind:'error',message:'The vault account changed.'};
        const existing = await transport.pull(VAULT_HEADER_SLOT);
        if (existing.kind !== 'absent') return { kind: 'exists' };
        const index: VaultIndex = { keys: [], hosts: {} };
        if (typeof carry.syncPassphrase === 'string' && carry.syncPassphrase !== '') index.sync = { passphrase: carry.syncPassphrase };
        let epoch = 1;
        if (verifier?.initialize) {
          const status = await verifier.status?.();
          if (status?.kind !== 'ok' || !Number.isSafeInteger(status.epoch) || status.epoch < 1) return {kind:'error',message:'Vault setup is temporarily unavailable. Try again.'};
          if (status.hasVerifier || status.kdf) return {kind:'exists'};
          epoch = status.epoch;
        }
        return await this.writeFreshVault(passphrase, index, epoch, 0, generation, transport, verifier, io.scope);
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  /**
   * Write a brand-new header. The vault is left unlocked unless a lock()
   * happened meanwhile (it is created either way).
   */
  private async writeFreshVault(
    passphrase: string,
    index: VaultIndex,
    epoch: number,
    baseVersion: number,
    generation: number,
    transport: VaultSlotTransport = this.transport,
    verifier: VaultServerVerifier | undefined = this.verifier,
    scope = this.currentScope(),
  ): Promise<VaultCreateResult> {
    if (!indexRoundTrips(index)) return { kind: 'error', message: 'refusing to write a vault index other devices could not read' };
    const created = await createVaultHeader({ passphrase, index, epoch, ...(this.kdf ? { kdf: this.kdf } : {}) });
    const data = serializeVaultHeader(created.header);
    if (byteLength(data) > VAULT_SLOT_LIMIT_BYTES) {
      wipe(created.dek);
      wipe(created.auth);
      return { kind: 'indexFull' };
    }
    if (scope !== this.currentScope() || !this.acceptsKnownRevision(scope,created.header,baseVersion + 1)) {
      wipe(created.dek); wipe(created.auth);
      return {kind:'error',message:'The vault account or accepted revision changed.'};
    }
    const atomic = baseVersion === 0 && verifier?.initialize !== undefined;
    let pushed: VaultSlotPushResult;
    try {
      pushed = atomic ? await verifier!.initialize!({data,auth:created.auth,epoch}) : await transport.push(VAULT_HEADER_SLOT, data, baseVersion);
    } catch (error) {wipe(created.dek);wipe(created.auth);throw error;}
    if (pushed.kind !== 'ok') {
      wipe(created.dek);
      wipe(created.auth);
      // A gated answer means a hidden vault already exists.
      return pushed.kind === 'error' ? { kind: 'error', message: pushed.message } : { kind: 'exists' };
    }
    if (!Number.isSafeInteger(pushed.version) || pushed.version !== baseVersion + 1
      || !this.acceptsKnownRevision(scope,created.header,pushed.version)) {
      wipe(created.dek); wipe(created.auth);
      return {kind:'error',message:'The vault returned an invalid accepted revision.'};
    }
    // Even a lock during the dispatched write must not erase knowledge of
    // the encrypted revision the server has just acknowledged accepting.
    this.rememberRevision(scope,created.header,pushed.version);
    const auth = Uint8Array.from(created.auth);
    if (atomic) wipe(created.auth);
    else await this.publishVerifier(created.auth, epoch, undefined, verifier);
    const installed = this.install(generation, {
      scope,
      header: created.header,
      version: pushed.version,
      dek: created.dek,
      auth,
      dekKey: await importAesKey(created.dek),
      index,
    });
    if (!installed) return { kind: 'ok' };
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
  private async publishVerifier(auth: Uint8Array, epoch: number, currentAuth?: Uint8Array, verifier = this.verifier): Promise<VaultSetVerifierResult> {
    try {
      if (!verifier) return { kind: 'unavailable' };
      const input = (at: number) => ({ auth, epoch: at, ...(currentAuth ? { currentAuth } : {}) });
      let result = await verifier.setVerifier(input(epoch));
      if (result.kind === 'epochMismatch') result = await verifier.setVerifier(input(result.epoch));
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

  /** Confirm a newly entered passphrase without replacing the live DEK/session.
   * The account IO and session are captured before queued KDF work starts. */
  confirmPassphrase(passphrase: string, active?: () => Promise<boolean>): Promise<VaultUnlockResult> {
    const context = this.mutationContext(active);
    return this.exclusive(async () => {
      if (!await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
      const wait = this.backoffRemainingMs();
      if (wait > 0) return {kind:'backoff',retryAfterMs:wait};
      try {
        const pulled = await this.pullHeader(context.state!.auth,context);
        if (pulled.kind !== 'ok') return pulled.kind === 'gated' ? {kind:'error',message:'Unlock your vault again before adding an entry.'} : pulled;
        if (!await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
        if (pulled.header.vaultId !== context.state!.header.vaultId || pulled.header.epoch !== context.state!.header.epoch) return {kind:'error',message:'Your vault changed. Unlock it again before adding an entry.'};
        const held = context.state!.header;
        if (!this.acceptsHeaderRevision(context.state!,pulled.header,pulled.version)
          || ['kdf','check','wrappedDek'].some(key => JSON.stringify(pulled.header[key as 'kdf' | 'check' | 'wrappedDek']) !== JSON.stringify(held[key as 'kdf' | 'check' | 'wrappedDek']))) {
          return {kind:'error',message:'Your vault changed. Unlock it again before adding an entry.'};
        }
        const keys = await derivePassphraseKeys(passphrase,pulled.header.kdf);
        try {
          if (!await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
          const verdict = context.verifier ? await context.verifier.verify(keys.auth) : {kind:'unavailable' as const};
          if (!await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
          if (verdict.kind === 'locked') return {kind:'rateLimited',retryAfterMs:Math.max(0,verdict.retryAfterMs)};
          if (!await verifyCheck(keys.kek,pulled.header)) return {kind:'wrongPassphrase',retryAfterMs:Math.max(this.recordFailure(),verdict.kind === 'wrong' ? verdict.retryAfterMs : 0)};
          if (!await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
          if (verdict.kind === 'wrong') return {kind:'error',message:'Your vault verification changed. Unlock it again before adding an entry.'};
          // Confirmation can observe a newer index than our live session.
          // Authenticate and retain it before authorizing the next mutation;
          // a later retry may not fall back to the pre-confirmation revision.
          const index = await openIndex(context.state!.dekKey,pulled.header);
          if (!await this.ownsMutation(context)) return {kind:'error',message:'The vault operation was cancelled.'};
          if (!index) return {kind:'corrupt'};
          context.state!.header = pulled.header;
          context.state!.version = pulled.version;
          context.state!.index = index;
          this.rememberRevision(context.scope,pulled.header,pulled.version);
          this.failures = 0;
          this.blockedUntil = 0;
          this.emit();
          return {kind:'ok'};
        } finally {wipe(keys.auth);}
      } catch (error) {return {kind:'error',message:describe(error)};}
    });
  }

  /**
   * Unlock with the account vault passphrase: Argon2id → (server verify, if
   * deployed) → check value → unwrap DEK → decrypt the index. A wrong
   * passphrase is a result, never a throw.
   */
  unlock(passphrase: string): Promise<VaultUnlockResult> {
    // Read at CALL time: a lock() in the same tick must win over the queued task.
    const generation = this.generation;
    const io = this.scopedIo();
    return this.exclusive(async () => {
      const wait = this.backoffRemainingMs();
      if (wait > 0) return { kind: 'backoff', retryAfterMs: wait };
      try {
        const status = await this.serverStatus(io.verifier);
        if (status && status.retryAfterMs > 0) return { kind: 'rateLimited', retryAfterMs: status.retryAfterMs };
        let header: VaultHeader;
        let version: number;
        let keys: VaultPassphraseKeys;
        let verdict: VaultVerifyResult = { kind: 'unavailable' };
        if (status?.kdf) {
          // Gated mode: the header is hidden until a verify, so the server's
          // public KDF params drive Argon2id and the server's answer is final.
          keys = await derivePassphraseKeys(passphrase, status.kdf);
          verdict = await this.verify(keys.auth,io.verifier);
          if (verdict.kind === 'locked') {
            wipe(keys.auth);
            return { kind: 'rateLimited', retryAfterMs: Math.max(0, verdict.retryAfterMs) };
          }
          if (verdict.kind === 'wrong') {
            wipe(keys.auth);
            return { kind: 'wrongPassphrase', retryAfterMs: Math.max(this.recordFailure(), verdict.retryAfterMs) };
          }
          // Just verified, so this read is inside the server's window.
          const pulled = await this.pullHeader(null,undefined,io);
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
          const pulled = await this.pullHeader(null,undefined,io);
          if (pulled.kind === 'gated') {
            return { kind: 'error', message: 'the server hides the vault but gave no KDF parameters (GET /vault/status)' };
          }
          if (pulled.kind !== 'ok') return pulled;
          ({ header, version } = pulled);
          if (!this.acceptsKnownRevision(io.scope,header,version)) return {kind:'error',message:'The vault returned data older than an accepted revision.'};
          keys = await derivePassphraseKeys(passphrase, header.kdf);
          verdict = await this.verify(keys.auth,io.verifier);
          if (verdict.kind === 'locked') {
            wipe(keys.auth);
            return { kind: 'rateLimited', retryAfterMs: Math.max(0, verdict.retryAfterMs) };
          }
        }
        const { kek, auth } = keys;
        if (!this.ownsIo(io) || !this.acceptsKnownRevision(io.scope,header,version)) {
          wipe(auth);
          return {kind:'error',message:'The vault account, lock state or accepted revision changed.'};
        }
        try {
          if (!(await verifyCheck(kek, header))) {
            wipe(auth);
            const delay = this.recordFailure();
            const server = verdict.kind === 'wrong' ? Math.max(0, verdict.retryAfterMs) : 0;
            return { kind: 'wrongPassphrase', retryAfterMs: Math.max(delay, server) };
          }
          // The check value is authoritative. A server with no verifier yet gets one now;
          // one that disagrees is stale and can only be fixed with the old passphrase.
          if (verdict.kind === 'noVerifier') await this.publishVerifier(Uint8Array.from(auth), status?.epoch ?? header.epoch,undefined,io.verifier);
          // A change whose verifier update failed left the server on the old AUTH: repair it with the kept proof.
          if (verdict.kind === 'wrong' && this.pendingVerifier && bytesEqual(this.pendingVerifier.auth, auth)) {
            await this.retryVerifierPublishNow();
          }
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
        if (!this.install(generation, { scope:io.scope, header, version, dek, dekKey, auth, index })) {
          return { kind: 'error', message: 'The vault was locked while it was being unlocked.' };
        }
        this.failures = 0;
        this.blockedUntil = 0;
        this.emit();
        return { kind: 'ok' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  private async serverStatus(verifier = this.verifier): Promise<Extract<VaultServerStatus, { kind: 'ok' }> | null> {
    if (!verifier?.status) return null;
    const status = await verifier.status().catch((): VaultServerStatus => ({ kind: 'unavailable' }));
    if (status.kind !== 'ok') return null;
    const kdf = status.kdf === undefined || status.kdf === null ? undefined : parseKdfParams(status.kdf) ?? undefined;
    return { ...status, retryAfterMs: Math.max(0, status.retryAfterMs || 0), ...(kdf ? { kdf } : {}) };
  }

  private async verify(auth: Uint8Array, verifier = this.verifier): Promise<VaultVerifyResult> {
    if (!verifier) return { kind: 'unavailable' };
    return verifier.verify(auth).catch((): VaultVerifyResult => ({ kind: 'unavailable' }));
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
    // Read at CALL time: a lock() in the same tick must win over the queued task.
    const generation = this.generation;
    const io = this.scopedIo();
    return this.exclusive(async () => {
      try {
        if (!record || !(record.dek instanceof Uint8Array) || record.dek.length !== 32) return { kind: 'stale' };
        const hasAuth = record.auth instanceof Uint8Array && record.auth.length === 32;
        const status = await this.serverStatus(io.verifier);
        if (status?.kdf) {
          // Gated: the header is only readable after a verify.
          if (!hasAuth) return { kind: 'stale' };
          if (status.retryAfterMs > 0) return { kind: 'rateLimited', retryAfterMs: status.retryAfterMs };
          const verdict = await this.verify(Uint8Array.from(record.auth as Uint8Array),io.verifier);
          if (verdict.kind === 'locked') return { kind: 'rateLimited', retryAfterMs: Math.max(0, verdict.retryAfterMs) };
          // A remembered AUTH the server rejects means the passphrase changed elsewhere.
          if (verdict.kind === 'wrong') return { kind: 'stale' };
        }
        const pulled = await this.pullHeader(hasAuth ? (record.auth as Uint8Array) : null,undefined,io);
        if (pulled.kind === 'gated') return { kind: 'stale' };
        if (pulled.kind !== 'ok') return pulled;
        const { header, version } = pulled;
        if (header.vaultId !== record.vaultId || header.epoch !== record.epoch) return { kind: 'stale' };
        if (!this.acceptsKnownRevision(io.scope,header,version)) return {kind:'stale'};
        const dek = Uint8Array.from(record.dek);
        const dekKey = await importAesKey(dek);
        const index = await openIndex(dekKey, header);
        if (!index) {
          wipe(dek);
          return { kind: 'stale' };
        }
        const auth = hasAuth ? Uint8Array.from(record.auth as Uint8Array) : null;
        if (!this.install(generation, { scope:io.scope, header, version, dek, dekKey, auth, index })) {
          return { kind: 'error', message: 'The vault was locked while it was being unlocked.' };
        }
        this.emit();
        return { kind: 'ok' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }

  /**
   * Read independently authenticated host trust. Callers persist the accepted
   * version floor account+vault+route scoped; absence is never permission to
   * reset a pin. Directory-advertised SSH keys are never inputs here.
   */
  async getTrustedHost(accountId: string, target: TrustedHostTarget, minimumRevision = 0): Promise<TrustedHostRead> {
    const state = this.unlocked;
    return this.exclusive(async () => {
      if (!state || this.unlocked !== state) return { kind: 'locked' };
      const refreshed = await this.refreshTrustedHostIndex(state);
      if (refreshed.kind !== 'ok') return refreshed;
      const slot = await trustedHostSlot(target);
      const pulled = await this.pull(slot,state.auth);
      return this.decodeTrustedHost(accountId,target,pulled,minimumRevision,state);
    });
  }

  /** Refresh authorization once per trust operation using the held DEK, never
   * a second passphrase. Call only within exclusive(): index writes cannot
   * interleave. lock()/account replacement still wins across every await. */
  private async refreshTrustedHostIndex(state: Unlocked, active: () => boolean = () => true): Promise<{kind:'ok'} | {kind:'locked'|'invalid'|'rollback'|'gated'}> {
    const owns = () => this.unlocked === state && !state.revisionRejected && state.scope === this.currentScope() && active();
    if (!owns()) return {kind:'locked'};
    const context:MutationContext={...this.scopedIo(),state,active:async()=>active()};
    const pulled = await this.pullHeader(state.auth,context);
    if (!owns()) return {kind:'locked'};
    if (pulled.kind === 'gated') return pulled;
    if (pulled.kind !== 'ok' || pulled.header.vaultId !== state.header.vaultId || pulled.header.epoch !== state.header.epoch
      || !Number.isSafeInteger(pulled.version) || pulled.version < 1) {
      this.lock();
      return {kind:'invalid'};
    }
    if (pulled.version < state.version) {
      this.lock();
      return {kind:'rollback'};
    }
    if (pulled.version === state.version && serializeVaultHeader(pulled.header) !== serializeVaultHeader(state.header)) {
      this.lock();
      return {kind:'invalid'};
    }
    const index = await openIndex(state.dekKey,pulled.header);
    if (!owns()) return {kind:'locked'};
    if (!index) {this.lock();return {kind:'invalid'};}
    state.header = pulled.header;
    state.version = pulled.version;
    state.index = index;
    this.rememberRevision(state.scope,pulled.header,pulled.version);
    this.emit();
    return {kind:this.unlocked === state ? 'ok' : 'locked'};
  }

  private async decodeTrustedHost(accountId: string, target: TrustedHostTarget, pulled: VaultSlotPullResult, minimumRevision: number, state: Unlocked): Promise<TrustedHostRead> {
    if (pulled.kind !== 'ok') return pulled.kind === 'absent' && minimumRevision > 0 ? { kind: 'rollback' } : pulled;
    if (this.unlocked !== state) return { kind: 'locked' };
    const e = parseTrustedHostEnvelope(pulled.data);
    if (!e || e.accountId !== accountId || e.vaultId !== state.header.vaultId || e.epoch !== state.header.epoch
      || e.serverUrl !== target.serverUrl || e.deviceId !== target.deviceId || e.revision !== pulled.version) return { kind: 'invalid' };
    if (e.revision < minimumRevision) return { kind: 'rollback' };
    const data = await openTrustedHost(state.dekKey, e);
    if (this.unlocked !== state) return { kind: 'locked' };
    if (!data) return { kind: 'invalid' };
    const binding = this.getHostBinding(data.hostAlias);
    if (data.status === 'active' && (!binding || binding.gatewayAuth !== 'managed' || binding.keyId !== data.keyId || !this.getKey(data.keyId))) return { kind: 'invalid' };
    const { v: _v, n: _n, ct: _ct, ...identity } = e;
    return { kind: 'ok', host: { ...identity, ...data, version: pulled.version } };
  }

  /** Version-CAS write; revoked descriptors remain authenticated tombstones. */
  putTrustedHost(accountId: string, target: TrustedHostTarget, data: TrustedHostData, baseVersion: number): Promise<VaultSlotPushResult | { kind: 'locked' }> {
    return this.exclusive(async () => {
      const state = this.unlocked;
      if (!state) return { kind: 'locked' };
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0 || baseVersion >= 1_000_000) return { kind: 'error', message: 'invalid trusted host version' };
      const binding = this.getHostBinding(data.hostAlias);
      if (data.status === 'active' && (!binding || binding.gatewayAuth !== 'managed' || binding.keyId !== data.keyId || !this.getKey(data.keyId))) return { kind: 'error', message: 'trusted host requires a managed vault key binding' };
      const envelope = await sealTrustedHost(state.dekKey, {
        ...target, accountId, vaultId: state.header.vaultId, epoch: state.header.epoch, revision: baseVersion + 1,
      }, data);
      if (this.unlocked !== state) return { kind: 'locked' };
      const serialized = JSON.stringify(envelope);
      if (serialized.length > VAULT_SLOT_LIMIT_BYTES) return { kind: 'error', message: 'trusted host descriptor too large' };
      return this.push(await trustedHostSlot(target), serialized, baseVersion);
    });
  }

  async listTrustedHosts(accountId: string, floors: Readonly<Record<string, number>> = {}): Promise<TrustedHostRecord[]> {
    const generation = this.unlocked;
    return this.exclusive(async () => {
    if (!generation) return [];
    if (this.unlocked !== generation) throw new Error('Vault changed while loading servers.');
    let active = true;
    const deadline = Date.now() + 15000;
    const timed = async <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Loading servers timed out.')),Math.max(0,deadline-Date.now()));})]);}
      finally {if(timer !== undefined) clearTimeout(timer);}
    };
    try {
    const refreshed = await timed(this.refreshTrustedHostIndex(generation,() => active));
    if (refreshed.kind !== 'ok') throw new Error(`Vault authorization could not be refreshed (${refreshed.kind}).`);
    const slots = await timed(this.transport.list());
    if (this.unlocked !== generation) throw new Error('Vault changed while loading servers.');
    if (slots.length > 4096) throw new Error('Too many account slots.');
    const trustedSlots = slots.filter(({slot}) => /^th-[A-Za-z0-9_-]{22}$/.test(slot));
    if (trustedSlots.length > 128 || new Set(trustedSlots.map(s=>s.slot)).size !== trustedSlots.length) throw new Error('Too many or duplicate trusted servers.');
    for (const slot of Object.keys(floors)) {
      if (floors[slot]! > 0 && !trustedSlots.some(row => row.slot === slot)) throw new Error('A previously trusted server descriptor is missing.');
    }
    const result: TrustedHostRecord[] = [];
    let cursor = 0;
    let halted = false;
    const worker = async () => {
      while(cursor < trustedSlots.length && !halted) {
        const {slot} = trustedSlots[cursor++]!;
        const pulled = await timed(this.pull(slot));
        if (pulled.kind !== 'ok') throw new Error('Server descriptor became unavailable.');
        const e = parseTrustedHostEnvelope(pulled.data);
        if (!e || await trustedHostSlot(e) !== slot) throw new Error('Invalid trusted server descriptor.');
        const trusted = await timed(this.decodeTrustedHost(accountId,e,pulled,floors[slot] ?? 0,generation));
        if (this.unlocked !== generation) throw new Error('Vault changed while loading servers.');
        if (trusted.kind !== 'ok') throw new Error(`Server trust could not be verified (${trusted.kind}).`);
        result.push(trusted.host);
      }
    };
    try { await Promise.all(Array.from({length:Math.min(4,trustedSlots.length)},worker)); }
    catch(e) {halted = true;throw e;}
    return result;
    } finally {active = false;}
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
    const generation = this.generation;
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
      if (generation !== this.generation) {
        wipe(pt);
        return { kind: 'locked' };
      }
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
  private async writeIndex(mutate: (index: VaultIndex) => boolean | VaultWriteFailure, context?: MutationContext): Promise<VaultWriteResult> {
    const state = context ? context.state : this.unlocked;
    const generation = context?.generation ?? this.generation;
    if (!state) return { kind: 'locked' };
    if (state.scope !== this.currentScope()) return {kind:'locked'};
    if (state.revisionRejected) return {kind:'vaultChanged'};
    for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
      if (this.unlocked !== state || generation !== this.generation) return {kind:'locked'};
      if (context && !await this.ownsMutation(context)) return {kind:'locked'};
      const index: VaultIndex = JSON.parse(JSON.stringify(state.index)) as VaultIndex;
      const verdict = mutate(index);
      if (verdict === false) return { kind: 'ok' };
      if (verdict !== true) return verdict;
      // Every other device parses what we seal: never write an index the parser rejects.
      if (!indexRoundTrips(index)) return { kind: 'error', message: 'refusing to write a vault index other devices could not read' };
      if (generation !== this.generation) return { kind: 'locked' };
      const header: VaultHeader = {
        ...state.header,
        index: await sealIndex(state.dekKey, state.header.vaultId, index),
        updatedAt: new Date(this.now()).toISOString(),
      };
      const data = serializeVaultHeader(header);
      if (byteLength(data) > VAULT_SLOT_LIMIT_BYTES) return { kind: 'indexFull' };
      let pushed: VaultSlotPushResult;
      try {
        pushed = await this.push(VAULT_HEADER_SLOT, data, state.version, context);
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
      if (pushed.kind === 'error') return { kind: 'error', message: pushed.message };
      if (pushed.kind === 'gated') return { kind: 'gated' };
      if (pushed.kind === 'ok') {
        if (!Number.isSafeInteger(pushed.version) || pushed.version !== state.version + 1) {
          state.revisionRejected = true;
          return {kind:'vaultChanged'};
        }
        this.rememberRevision(state.scope,header,pushed.version);
        if (context && !await this.ownsMutation(context)) return {kind:'locked'};
        state.header = header;
        state.version = pushed.version;
        state.index = index;
        this.emit();
        return { kind: 'ok' };
      }
      if (generation !== this.generation) return { kind: 'locked' };
      const rebased = await this.rebase(state, context);
      if (rebased.kind !== 'ok') return rebased;
      if (generation !== this.generation) return { kind: 'locked' };
    }
    return { kind: 'conflictLimit' };
  }

  /** Re-pull the header after a conflict and re-open it with the DEK we hold. */
  private async rebase(state: Unlocked, context?: MutationContext): Promise<{ kind: 'ok' } | VaultWriteFailure> {
    if (this.unlocked !== state) return {kind:'locked'};
    if (state.revisionRejected) return {kind:'vaultChanged'};
    let pulled;
    try {
      pulled = await this.pullHeader(state.auth, context);
    } catch (error) {
      return { kind: 'error', message: describe(error) };
    }
    if (this.unlocked !== state || (context && !await this.ownsMutation(context))) return {kind:'locked'};
    if (pulled.kind === 'gated') return { kind: 'gated' };
    if (pulled.kind !== 'ok' || pulled.header.vaultId !== state.header.vaultId || pulled.header.epoch !== state.header.epoch) {
      this.lock();
      return { kind: 'vaultChanged' };
    }
    if (!this.acceptsHeaderRevision(state,pulled.header,pulled.version)) return {kind:'vaultChanged'};
    const index = await openIndex(state.dekKey, pulled.header);
    if (this.unlocked !== state || (context && !await this.ownsMutation(context))) return {kind:'locked'};
    if (!index) {
      this.lock();
      return { kind: 'vaultChanged' };
    }
    state.header = pulled.header;
    state.version = pulled.version;
    state.index = index;
    this.rememberRevision(state.scope,pulled.header,pulled.version);
    return { kind: 'ok' };
  }

  /** Write a `vk-` slot (create, or overwrite whatever is there). */
  private async writeBlob(keyId: string, data: string, context?: MutationContext): Promise<{ kind: 'ok' } | { kind: 'gated' } | { kind: 'error'; message: string }> {
    const slot = vaultKeySlot(keyId);
    let base = 0;
    for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
      try {
        const pushed = await this.push(slot, data, base, context);
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
  addKey(pem: string, name: string, keyPassphrase?: string | null, active?: () => Promise<boolean>, binding?: AdditionBinding): Promise<VaultAddKeyResult> {
    const context = this.mutationContext(active);
    const target = binding ? {...binding} : undefined;
    return this.exclusive(async () => {
      const unlocked = context.state;
      if (!unlocked || !await this.ownsMutation(context)) return { kind: 'locked' };
      if (target && (target.hostAlias === '' || target.hostAlias === '__proto__' || !isGatewayAuthPolicy(target.gatewayAuth))) return {kind:'error',message:'invalid host binding'};
      const prepared = await prepareSshPrivateKey(pem, keyPassphrase);
      if (!await this.ownsMutation(context)) return {kind:'locked'};
      if (prepared.kind !== 'ok') return prepared;
      const key = prepared.key;
      const existed = unlocked.index.keys.some((entry) => entry.keyId === key.keyId);
      if (existed) {
        // Never rewrite a stored key's slot on a duplicate upload: the vault
        // copy stays authoritative. Only a lost slot is restored.
        const present = await this.pull(vaultKeySlot(key.keyId),unlocked.auth,context);
        if (!await this.ownsMutation(context)) return {kind:'locked'};
        if (present.kind !== 'absent') {
          if (present.kind === 'ok' && target) {
            const bound = await this.writeIndex(index => {
              const old = index.hosts[target.hostAlias];
              if(old?.keyId === key.keyId && old.gatewayAuth === target.gatewayAuth)return false;
              index.hosts[target.hostAlias] = {keyId:key.keyId,gatewayAuth:target.gatewayAuth};return true;
            },context);
            if(bound.kind !== 'ok')return bound;
          }
          return present.kind === 'ok'
            ? { kind: 'ok', entry: this.getKey(key.keyId) as VaultKeyEntry, deduplicated: true }
            : { kind: 'gated' };
        }
      }
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
      const wrote = await this.writeBlob(key.keyId, blobData, context);
      if (wrote.kind !== 'ok') return wrote;
      if (!await this.ownsMutation(context)) return {kind:'locked'};
      const entry: VaultKeyEntry = {
        keyId: key.keyId,
        name: clampVaultName(name, key.type),
        type: key.type,
        fingerprint: key.fingerprint,
        createdAt: new Date(this.now()).toISOString(),
      };
      const result = await this.writeIndex((index) => {
        const duplicate = index.keys.some((existing) => existing.keyId === entry.keyId);
        if (!duplicate) index.keys.push(entry);
        const old = target ? index.hosts[target.hostAlias] : undefined;
        const changed = !!target && (old?.keyId !== entry.keyId || old.gatewayAuth !== target.gatewayAuth);
        if (target) index.hosts[target.hostAlias] = {keyId:entry.keyId,gatewayAuth:target.gatewayAuth};
        return !duplicate || changed;
      },context);
      if (result.kind !== 'ok') {
        if (!existed && await this.ownsMutation(context)) await context.transport.delete(vaultKeySlot(key.keyId)).catch(() => undefined);
        return result;
      }
      return { kind: 'ok', entry: this.getKey(key.keyId) ?? entry, deduplicated: existed };
    });
  }

  /** Add a host password as a vault entry (random keyId). */
  addPassword(password: string, name: string, active?: () => Promise<boolean>, binding?: AdditionBinding): Promise<VaultAddPasswordResult> {
    const context = this.mutationContext(active);
    const target = binding ? {...binding} : undefined;
    return this.exclusive(async () => {
      const unlocked = context.state;
      if (!unlocked || !await this.ownsMutation(context)) return { kind: 'locked' };
      if (target && (target.hostAlias === '' || target.hostAlias === '__proto__' || !isGatewayAuthPolicy(target.gatewayAuth))) return {kind:'error',message:'invalid host binding'};
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
      const wrote = await this.writeBlob(keyId, blobData, context);
      if (wrote.kind !== 'ok') return wrote;
      if (!await this.ownsMutation(context)) return {kind:'locked'};
      const entry: VaultKeyEntry = {
        keyId,
        name: clampVaultName(name, 'Password'),
        type: 'password',
        createdAt: new Date(this.now()).toISOString(),
      };
      const result = await this.writeIndex((index) => {
        index.keys.push(entry);
        if (target) index.hosts[target.hostAlias] = {keyId,gatewayAuth:target.gatewayAuth};
        return true;
      },context);
      if (result.kind !== 'ok') {
        if (await this.ownsMutation(context)) await context.transport.delete(vaultKeySlot(keyId)).catch(() => undefined);
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
    const context = this.mutationContext();
    return this.exclusive(async () => {
      const result = await this.writeIndex((index) => {
        const before = index.keys.length;
        index.keys = index.keys.filter((entry) => entry.keyId !== keyId);
        return index.keys.length !== before;
      },context);
      if (result.kind === 'ok' && isId16(keyId) && await this.ownsMutation(context)) {
        try {
          await context.transport.delete(vaultKeySlot(keyId));
        } catch {
          // An orphaned blob is unreadable without the index entry's type and harmless.
        }
      }
      return result;
    });
  }

  renameKey(keyId: string, name: string): Promise<VaultWriteResult> {
    const context = this.mutationContext();
    return this.exclusive(() =>
      this.writeIndex((index) => {
        const entry = index.keys.find((key) => key.keyId === keyId);
        const trimmed = clampVaultName(name, '');
        if (!entry || trimmed === '' || entry.name === trimmed) return false;
        entry.name = trimmed;
        return true;
      },context),
    );
  }

  /** Record that `newKeyId` replaces `oldKeyId`: rebind its hosts and drop the old key. */
  rotateKey(oldKeyId: string, newKeyId: string, active?: () => Promise<boolean>): Promise<VaultWriteResult> {
    const context = this.mutationContext(active);
    return this.exclusive(async () => {
      if (!await this.ownsMutation(context)) return {kind:'locked'};
      const result = await this.writeIndex((index) => {
        const next = index.keys.find((key) => key.keyId === newKeyId);
        if (!next || oldKeyId === newKeyId) return { kind: 'error', message: 'unknown replacement key' };
        if (!isId16(oldKeyId)) return { kind: 'error', message: 'invalid key id' };
        next.rotatedFrom = oldKeyId;
        index.keys = index.keys.filter((key) => key.keyId !== oldKeyId);
        for (const binding of Object.values(index.hosts)) {
          if (binding.keyId === oldKeyId) binding.keyId = newKeyId;
        }
        return true;
      },context);
      if (result.kind === 'ok' && isId16(oldKeyId) && await this.ownsMutation(context)) await context.transport.delete(vaultKeySlot(oldKeyId)).catch(() => undefined);
      return result;
    });
  }

  /** Bind an account host alias to a vault entry with a gateway auth policy. */
  bindHost(hostAlias: string, keyId: string, gatewayAuth: GatewayAuthPolicy, active?: () => Promise<boolean>): Promise<VaultWriteResult> {
    const context = this.mutationContext(active);
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
      },context),
    );
  }

  unbindHost(hostAlias: string): Promise<VaultWriteResult> {
    const context = this.mutationContext();
    return this.exclusive(() =>
      this.writeIndex((index) => {
        if (!Object.prototype.hasOwnProperty.call(index.hosts, hostAlias)) return false;
        delete index.hosts[hostAlias];
        return true;
      },context),
    );
  }

  /** Store (or clear, with null) the account settings-sync passphrase in the index. */
  setSyncPassphrase(passphrase: string | null): Promise<VaultWriteResult> {
    const context = this.mutationContext();
    return this.exclusive(() =>
      this.writeIndex((index) => {
        if ((index.sync?.passphrase ?? null) === passphrase) return false;
        if (passphrase === null) delete index.sync;
        else index.sync = { passphrase };
        return true;
      },context),
    );
  }

  /**
   * Change the vault passphrase: verify the current one, then a new salt,
   * KEK, wrapped DEK and check value in one header write. Key blobs and
   * other devices' remembered DEKs keep working.
   */
  changePassphrase(current: string, next: string): Promise<VaultChangePassphraseResult> {
    const generation = this.generation;
    const context = this.mutationContext();
    return this.exclusive(async () => {
      const state = context.state;
      if (state?.revisionRejected) return {kind:'vaultChanged'};
      if (!state || !await this.ownsMutation(context)) return { kind: 'locked' };
      const wait = this.backoffRemainingMs();
      if (wait > 0) return { kind: 'backoff', retryAfterMs: wait };
      // Our own copy: lock() wipes state.dek in place, and a wrap of a wiped
      // buffer would seal 32 zero bytes and lose the vault.
      const dek = Uint8Array.from(state.dek);
      const verifiedCheck = state.header.check.ct;
      const auths: Uint8Array[] = [];
      try {
        const old = await derivePassphraseKeys(current, state.header.kdf);
        auths.push(old.auth);
        if (!(await verifyCheck(old.kek, state.header))) {
          return { kind: 'wrongPassphrase', retryAfterMs: this.recordFailure() };
        }
        this.failures = 0;
        const kdf = newKdfParams(this.kdf ?? { m: state.header.kdf.m, t: state.header.kdf.t, p: state.header.kdf.p });
        const fresh = await derivePassphraseKeys(next, kdf);
        auths.push(fresh.auth);
        const wrapped = await wrapDek(fresh.kek, dek, state.header.vaultId);
        // W2 order: header first (inside the old AUTH's verify window), then
        // the verifier with the old AUTH as proof.
        for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
          if (generation !== this.generation) return { kind: 'locked' };
          if (state.header.check.ct !== verifiedCheck) return { kind: 'passphraseChangedElsewhere' };
          const header: VaultHeader = { ...state.header, kdf, ...wrapped, updatedAt: new Date(this.now()).toISOString() };
          // Prove the new header opens with the new passphrase before it replaces the old one.
          const reopened = await unwrapDek(fresh.kek, header);
          const intact = reopened !== null && bytesEqual(reopened, dek) && (await openIndex(await importAesKey(reopened), header)) !== null;
          wipe(reopened);
          if (!intact) return { kind: 'error', message: 'the re-wrapped vault did not verify; nothing was written' };
          const pushed = await this.push(VAULT_HEADER_SLOT, serializeVaultHeader(header), state.version,context);
          if (pushed.kind === 'error') return { kind: 'error', message: pushed.message };
          if (pushed.kind === 'gated') return { kind: 'gated' };
          if (pushed.kind === 'ok') {
            if (!Number.isSafeInteger(pushed.version) || pushed.version !== state.version + 1) {
              state.revisionRejected = true;
              return {kind:'vaultChanged'};
            }
            this.rememberRevision(state.scope,header,pushed.version);
            state.header = header;
            state.version = pushed.version;
            const keep = { auth: Uint8Array.from(fresh.auth), currentAuth: Uint8Array.from(old.auth), epoch: header.epoch,scope:context.scope };
            const published = await this.publishVerifier(Uint8Array.from(fresh.auth), header.epoch, Uint8Array.from(old.auth),context.verifier);
            const pending = context.verifier !== undefined && published.kind !== 'ok';
            const canKeep = this.unlocked === state && this.ownsIo(context);
            this.setPendingVerifier(pending && canKeep ? keep : null);
            if (!pending || !canKeep) {
              wipe(keep.auth);
              wipe(keep.currentAuth);
            }
            if (generation === this.generation) {
              wipe(state.auth);
              state.auth = Uint8Array.from(fresh.auth);
            }
            this.emit();
            return pending ? { kind: 'ok', verifierPending: true } : { kind: 'ok' };
          }
          const rebased = await this.rebase(state,context);
          if (rebased.kind !== 'ok') return rebased;
        }
        return { kind: 'conflictLimit' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      } finally {
        wipe(dek);
        for (const auth of auths) wipe(auth);
      }
    });
  }

  private setPendingVerifier(next: NonNullable<KeyVaultStore['pendingVerifier']> | null): void {
    if (this.pendingVerifier) {
      wipe(this.pendingVerifier.auth);
      wipe(this.pendingVerifier.currentAuth);
    }
    this.pendingVerifier = next;
  }

  /** Whether a passphrase change still owes the server its new verifier. */
  get verifierPending(): boolean {
    return this.pendingVerifier !== null;
  }

  /** Retry a verifier update a passphrase change could not deliver. */
  retryVerifierPublish(): Promise<VaultSetVerifierResult> {
    return this.exclusive(() => this.retryVerifierPublishNow());
  }

  private async retryVerifierPublishNow(): Promise<VaultSetVerifierResult> {
    const pending = this.pendingVerifier;
    if (!pending) return { kind: 'unavailable' };
    if (pending.scope !== this.currentScope()) return {kind:'unavailable'};
    // Reacquire current credentials for the same namespace (tokens can have
    // refreshed), rather than retaining an expiring token snapshot in memory.
    let io:ScopedIo;
    try {io=this.scopedIo();} catch {return {kind:'unavailable'};}
    if (io.scope !== pending.scope || !this.ownsIo(io)) return {kind:'unavailable'};
    const result = await this.publishVerifier(Uint8Array.from(pending.auth), pending.epoch, Uint8Array.from(pending.currentAuth),io.verifier);
    if (result.kind === 'ok') this.setPendingVerifier(null);
    return result;
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
    // Read at CALL time: a lock() in the same tick must win over the queued task.
    const generation = this.generation;
    const io = this.scopedIo();
    return this.exclusive(async () => {
      try {
        const current = this.unlocked?.scope === io.scope ? this.unlocked : null;
        const accountCurrent = () => io.scope === this.currentScope();
        if (!accountCurrent()) return {kind:'error',message:'The vault account changed.'};
        const index: VaultIndex = {
          keys: [],
          hosts: carry.hosts ?? (current ? JSON.parse(JSON.stringify(current.index.hosts)) : {}),
        };
        const sync = carry.syncPassphrase !== undefined ? carry.syncPassphrase : current?.index.sync?.passphrase ?? null;
        if (typeof sync === 'string' && sync !== '') index.sync = { passphrase: sync };
        // Refuse before anything is wiped: a fresh vault other devices cannot read is worse than none.
        if (!indexRoundTrips(index)) return { kind: 'error', message: 'the host bindings to carry over are not valid' };
        // An older client must never wipe a vault written by a newer format.
        if (carry.forceUnsupported !== true) {
          const existing = await this.pullHeader(current?.auth ?? null,undefined,io);
          if (existing.kind === 'unsupportedVersion') return { kind: 'unsupportedVersion' };
        }

        let serverEpoch: number | null = null;
        if (!accountCurrent()) return {kind:'error',message:'The vault account changed.'};
        if (io.verifier?.reset) {
          const wiped = await io.verifier.reset().catch((): VaultServerResetResult => ({ kind: 'unavailable' }));
          if (wiped.kind === 'freshAuthRequired') return { kind: 'freshAuthRequired' };
          if (wiped.kind === 'ok') serverEpoch = wiped.epoch;
        }
        // Without the server (phase 1) the client wipes slot by slot; after a
        // server reset this finds nothing left to delete.
        const slots = await io.transport.list();
        for (const { slot } of slots) {
          if (!accountCurrent()) return {kind:'error',message:'The vault account changed.'};
          if (keyIdFromSlot(slot) !== null) await io.transport.delete(slot);
        }
        let epoch = serverEpoch ?? 1;
        let base = 0;
        for (let attempt = 0; attempt <= CONFLICT_RETRIES; attempt += 1) {
          if (!accountCurrent()) return {kind:'error',message:'The vault account changed.'};
          const pulled = await io.transport.pull(VAULT_HEADER_SLOT);
          if (pulled.kind === 'gated') {
            return { kind: 'error', message: 'the server hides the vault; reset it through the server (POST /vault/reset)' };
          }
          if (pulled.kind === 'ok') {
            base = pulled.version;
            const old = parseVaultHeader(pulled.data);
            // A corrupt header still has to go; its epoch is unknown, so jump past any plausible one.
            epoch = Math.max(epoch, old ? old.epoch + 1 : Math.floor(this.now() / 1000));
          }
          const written = await this.writeFreshVault(newPassphrase, index, epoch, base, generation,io.transport,io.verifier,io.scope);
          if (written.kind !== 'exists') return written;
        }
        return { kind: 'error', message: 'the vault kept changing during reset; try again' };
      } catch (error) {
        return { kind: 'error', message: describe(error) };
      }
    });
  }
}
