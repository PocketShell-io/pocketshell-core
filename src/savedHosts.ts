import { normalizeGatewayTarget, type GatewayTransportTarget } from './gatewayTransport';
import { MAX_PORT } from './net';
import { isValidTcpPort } from './portForwardPolicy';
import type { SshHostTarget, SshKeyHandleCredential } from './sshCapability';
import type { HostEntry } from './types';

/**
 * Client-persisted SSH hosts with stable identities.
 *
 * Desktop reads hosts from ~/.ssh/config and web from the synced account; a
 * client that owns its host list (Android) keeps it here. Every host carries a
 * stable `id` that the connection controller uses as `hostId` and as the
 * trust-pin key, so renaming or re-addressing a host keeps its trust record.
 * Credentials are opaque references only: key bytes and passphrases never
 * enter this model or its persisted document.
 */
export const SAVED_HOSTS_STORAGE_KEY = 'pocketshell.js.saved-hosts.v1';
export const SAVED_HOSTS_SCHEMA_VERSION = 1;

export interface StringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Opaque reference to a key held by the platform key store. */
export interface SavedHostKeyRef {
  kind: 'key-handle';
  handleId: string;
  /** Display name for the key; never key material. */
  label: string;
  passphraseRequired: boolean;
}

/**
 * Validate one persisted credential reference. Return null for "no key";
 * throw {@link SavedHostStoreError} for malformed data. A client whose native
 * layer still speaks an older reference shape supplies its own validator.
 */
export type SavedHostCredentialValidator<C> = (value: unknown) => C | null;

/** The endpoint fields reuse the core SSH target shape, so no second host contract exists. */
type SavedHostEndpoint = Pick<SshHostTarget, 'hostname' | 'port' | 'username'>;

export interface SavedHostInput<C = SavedHostKeyRef> extends SavedHostEndpoint {
  name: string;
  credentialRef: C | null;
  /**
   * Set when the host is reached through the PocketShell gateway (#3086): the
   * canonical gateway origin and the enrolled device id, exactly
   * {@link HostEntry.gateway}. `hostname`/`port` are then display labels the
   * gateway transport never resolves or dials. Absent for an ordinary host —
   * the key is omitted, never `undefined` or `null`, so a stored document
   * reads the same as before for every non-gateway host. Neither field is a
   * secret: the host-key pin and the route token live with the platform.
   */
  gateway?: GatewayTransportTarget;
}

export interface SavedHost<C = SavedHostKeyRef> extends SavedHostInput<C> {
  /** Stable identity: the controller hostId and the trust-pin key. */
  id: string;
}

/** A read-only copy of the store's user-visible state, for a platform bridge to hand to the UI. */
export interface SavedHostSnapshot<C = SavedHostKeyRef> {
  hosts: SavedHost<C>[];
  selectedHostId: string | null;
  defaultHostId: string | null;
}

interface SavedHostDocument<C> {
  schemaVersion: typeof SAVED_HOSTS_SCHEMA_VERSION;
  hosts: SavedHost<C>[];
  selectedHostId: string | null;
  defaultHostId: string | null;
  /** True once the user (or an earlier import) chose the default; later imports then leave it alone. */
  defaultHostExplicitlySet: boolean;
  /** IDs that arrived through {@link SavedHostStore.importHosts}. */
  importedHostIds: string[];
  /** Imported IDs the user deleted; a re-run import must not resurrect them. */
  importTombstones: string[];
}

export class SavedHostStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedHostStoreError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Default validator for {@link SavedHostKeyRef}. */
export function validateSavedHostKeyRef(value: unknown): SavedHostKeyRef | null {
  if (value === null) return null;
  if (!isRecord(value)
    || value.kind !== 'key-handle'
    || typeof value.handleId !== 'string'
    || value.handleId.trim().length === 0
    || typeof value.label !== 'string'
    || value.label.trim().length === 0
    || typeof value.passphraseRequired !== 'boolean'
    || Object.keys(value).some((key) => !['kind', 'handleId', 'label', 'passphraseRequired'].includes(key))) {
    throw new SavedHostStoreError('A saved host has a malformed key reference.');
  }
  return {
    kind: 'key-handle',
    handleId: value.handleId,
    label: value.label,
    passphraseRequired: value.passphraseRequired,
  };
}

/** Normalize and validate user-entered host fields. */
export function validateSavedHostInput<C>(
  input: SavedHostInput<C>,
  validateCredential: SavedHostCredentialValidator<C>,
): SavedHostInput<C> {
  const name = input.name.trim();
  const hostname = input.hostname.trim();
  const username = input.username.trim();
  if (name.length === 0 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new SavedHostStoreError('Enter a host name with 1 to 80 printable characters.');
  }
  if (hostname.length === 0 || hostname.length > 253 || /[\s/@\u0000-\u001f\u007f]/.test(hostname)) {
    throw new SavedHostStoreError('Enter a valid host name or IP address.');
  }
  if (!isValidTcpPort(input.port)) {
    throw new SavedHostStoreError(`Port must be a whole number from 1 to ${MAX_PORT}.`);
  }
  if (username.length === 0 || username.length > 128 || /[\s\u0000-\u001f\u007f]/.test(username)) {
    throw new SavedHostStoreError('Enter a valid SSH user name.');
  }
  const normalized: SavedHostInput<C> = { name, hostname, port: input.port, username, credentialRef: validateCredential(input.credentialRef) };
  // Presence, not truthiness: a null or malformed marker is refused, never
  // silently dropped into an ordinary SSH host (core #3059). Only an absent
  // (or `undefined`) member means "not a gateway host".
  if (input.gateway !== undefined) normalized.gateway = validateGatewayMarker(input.gateway);
  return normalized;
}

/** A saved host's gateway marker, canonical, or a refusal. */
function validateGatewayMarker(value: unknown): GatewayTransportTarget {
  const target = normalizeGatewayTarget(value);
  if (target === null) {
    throw new SavedHostStoreError('Enter the gateway address as a wss:// origin and the device id the gateway enrolled.');
  }
  return target;
}

function validateHost<C>(value: unknown, validateCredential: SavedHostCredentialValidator<C>): SavedHost<C> {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || value.id.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.id)
    || typeof value.name !== 'string'
    || typeof value.hostname !== 'string'
    || typeof value.port !== 'number'
    || typeof value.username !== 'string') {
    throw new SavedHostStoreError('A saved host record is malformed.');
  }
  const input = validateSavedHostInput({
    name: value.name,
    hostname: value.hostname,
    port: value.port,
    username: value.username,
    credentialRef: (value.credentialRef ?? null) as C | null,
    ...(value.gateway !== undefined ? { gateway: value.gateway as GatewayTransportTarget } : {}),
  }, validateCredential);
  return { id: value.id, ...input };
}

function emptyDocument<C>(): SavedHostDocument<C> {
  return {
    schemaVersion: SAVED_HOSTS_SCHEMA_VERSION,
    hosts: [],
    selectedHostId: null,
    defaultHostId: null,
    defaultHostExplicitlySet: false,
    importedHostIds: [],
    importTombstones: [],
  };
}

function uniqueStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) return null;
  const strings = value as string[];
  return new Set(strings).size === strings.length ? [...strings] : null;
}

function validateDocument<C>(value: unknown, validateCredential: SavedHostCredentialValidator<C>): SavedHostDocument<C> {
  if (!isRecord(value)
    || value.schemaVersion !== SAVED_HOSTS_SCHEMA_VERSION
    || !Array.isArray(value.hosts)
    || !(value.selectedHostId === null || typeof value.selectedHostId === 'string')
    || !(value.defaultHostId === null || typeof value.defaultHostId === 'string')
    || typeof value.defaultHostExplicitlySet !== 'boolean') {
    throw new SavedHostStoreError('Saved hosts data is malformed or uses an unsupported version; the stored data was left unchanged.');
  }
  const importedHostIds = uniqueStrings(value.importedHostIds);
  const importTombstones = uniqueStrings(value.importTombstones);
  if (!importedHostIds || !importTombstones || importTombstones.some((id) => !importedHostIds.includes(id))) {
    throw new SavedHostStoreError('Saved hosts contain conflicting import markers; the stored data was left unchanged.');
  }
  const hosts = value.hosts.map((host) => validateHost(host, validateCredential));
  const ids = new Set<string>();
  for (const host of hosts) {
    if (ids.has(host.id)) {
      throw new SavedHostStoreError('Saved hosts contain a conflicting duplicate host ID; the stored data was left unchanged.');
    }
    ids.add(host.id);
  }
  if ((value.selectedHostId !== null && !ids.has(value.selectedHostId))
    || (value.defaultHostId !== null && !ids.has(value.defaultHostId))) {
    throw new SavedHostStoreError('Saved hosts refer to a missing selected or default host; the stored data was left unchanged.');
  }
  return {
    schemaVersion: SAVED_HOSTS_SCHEMA_VERSION,
    hosts,
    selectedHostId: value.selectedHostId,
    defaultHostId: value.defaultHostId,
    defaultHostExplicitlySet: value.defaultHostExplicitlySet,
    importedHostIds,
    importTombstones,
  };
}

function sameHost<C>(left: SavedHost<C>, right: SavedHost<C>): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.hostname === right.hostname
    && left.port === right.port
    && left.username === right.username
    && JSON.stringify(left.credentialRef) === JSON.stringify(right.credentialRef)
    && JSON.stringify(left.gateway ?? null) === JSON.stringify(right.gateway ?? null);
}

function cloneHost<C>(host: SavedHost<C>): SavedHost<C> {
  return JSON.parse(JSON.stringify(host)) as SavedHost<C>;
}

function createHostId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const suffix = Math.random().toString(36).slice(2, 14);
  return `host-${Date.now().toString(36)}-${suffix}`;
}

export interface SavedHostStoreOptions<C> {
  validateCredential: SavedHostCredentialValidator<C>;
  createId?: () => string;
}

/**
 * The saved-host model: CRUD, ordering, selection, default host and import,
 * validated in full before every durable write. A load or write that would
 * produce an invalid document throws and leaves storage untouched.
 */
export class SavedHostStore<C = SavedHostKeyRef> {
  private document: SavedHostDocument<C> = emptyDocument<C>();
  private readonly validateCredential: SavedHostCredentialValidator<C>;
  private readonly createId: () => string;

  constructor(
    private readonly storage: StringStorage,
    options: SavedHostStoreOptions<C>,
  ) {
    this.validateCredential = options.validateCredential;
    this.createId = options.createId ?? createHostId;
  }

  get hosts(): SavedHost<C>[] {
    return this.document.hosts.map(cloneHost);
  }

  get selectedHostId(): string | null {
    return this.document.selectedHostId;
  }

  get defaultHostId(): string | null {
    return this.document.defaultHostId;
  }

  get selectedHost(): SavedHost<C> | null {
    const host = this.document.hosts.find((candidate) => candidate.id === this.document.selectedHostId);
    return host ? cloneHost(host) : null;
  }

  snapshot(): SavedHostSnapshot<C> {
    return {
      hosts: this.hosts,
      selectedHostId: this.document.selectedHostId,
      defaultHostId: this.document.defaultHostId,
    };
  }

  load(): void {
    const raw = this.storage.getItem(SAVED_HOSTS_STORAGE_KEY);
    if (raw === null) {
      this.document = emptyDocument<C>();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new SavedHostStoreError('Saved hosts data contains malformed JSON; the stored data was left unchanged.');
    }
    this.document = validateDocument(parsed, this.validateCredential);
  }

  validateInput(input: SavedHostInput<C>): SavedHostInput<C> {
    return validateSavedHostInput(input, this.validateCredential);
  }

  /** Add a host; the first host becomes the default. */
  add(input: SavedHostInput<C>): SavedHost<C> {
    const normalized = this.validateInput(input);
    const id = this.createId();
    if (!id || this.document.hosts.some((host) => host.id === id)) {
      throw new SavedHostStoreError('A stable host ID could not be allocated.');
    }
    const host: SavedHost<C> = { id, ...normalized };
    const next = { ...this.document, hosts: [...this.document.hosts, host] };
    if (next.defaultHostId === null && !next.defaultHostExplicitlySet) {
      next.defaultHostId = id;
      next.defaultHostExplicitlySet = true;
    }
    this.commit(next);
    return cloneHost(host);
  }

  update(id: string, input: SavedHostInput<C>): SavedHost<C> {
    const index = this.document.hosts.findIndex((host) => host.id === id);
    if (index < 0) throw new SavedHostStoreError('The selected host no longer exists.');
    const host: SavedHost<C> = { id, ...this.validateInput(input) };
    const hosts = [...this.document.hosts];
    hosts[index] = host;
    this.commit({ ...this.document, hosts });
    return cloneHost(host);
  }

  delete(id: string): void {
    if (!this.document.hosts.some((host) => host.id === id)) return;
    const deletingDefault = this.document.defaultHostId === id;
    this.commit({
      ...this.document,
      hosts: this.document.hosts.filter((host) => host.id !== id),
      selectedHostId: this.document.selectedHostId === id ? null : this.document.selectedHostId,
      defaultHostId: deletingDefault ? null : this.document.defaultHostId,
      defaultHostExplicitlySet: deletingDefault || this.document.defaultHostExplicitlySet,
      importTombstones: this.document.importedHostIds.includes(id)
        ? [...this.document.importTombstones, id]
        : this.document.importTombstones,
    });
  }

  select(id: string | null): void {
    if (id !== null && !this.document.hosts.some((host) => host.id === id)) {
      throw new SavedHostStoreError('The selected host no longer exists.');
    }
    this.commit({ ...this.document, selectedHostId: id });
  }

  setDefault(id: string | null): void {
    if (id !== null && !this.document.hosts.some((host) => host.id === id)) {
      throw new SavedHostStoreError('The default host no longer exists.');
    }
    this.commit({ ...this.document, defaultHostId: id, defaultHostExplicitlySet: true });
  }

  /** Put one host at a new list position without changing its identity. */
  move(id: string, destinationIndex: number): void {
    const sourceIndex = this.document.hosts.findIndex((host) => host.id === id);
    if (sourceIndex < 0) throw new SavedHostStoreError('The selected host no longer exists.');
    if (!Number.isSafeInteger(destinationIndex) || destinationIndex < 0 || destinationIndex >= this.document.hosts.length) {
      throw new SavedHostStoreError('The requested host position is invalid.');
    }
    const hosts = [...this.document.hosts];
    const [host] = hosts.splice(sourceIndex, 1);
    if (!host) throw new SavedHostStoreError('The selected host no longer exists.');
    hosts.splice(destinationIndex, 0, host);
    this.commit({ ...this.document, hosts });
  }

  /**
   * Merge hosts from another durable source (a migrated install) by their own
   * IDs. Re-running is idempotent; user edits and deletions win over the
   * source; a conflicting duplicate throws before anything is written.
   */
  importHosts(hosts: readonly SavedHost<C>[], defaultHostId: string | null): void {
    const imported = hosts.map((candidate) => validateHost(candidate, this.validateCredential));
    const existingById = new Map(this.document.hosts.map((host) => [host.id, host]));
    const incomingById = new Map<string, SavedHost<C>>();
    for (const candidate of imported) {
      if (this.document.importTombstones.includes(candidate.id)) continue;
      const duplicate = incomingById.get(candidate.id);
      if (duplicate && !sameHost(duplicate, candidate)) {
        throw new SavedHostStoreError(`Imported hosts contain conflicting duplicate ID ${candidate.id}; neither record was overwritten.`);
      }
      incomingById.set(candidate.id, candidate);
      const existing = existingById.get(candidate.id);
      if (existing && !this.document.importedHostIds.includes(candidate.id) && !sameHost(existing, candidate)) {
        throw new SavedHostStoreError(`Imported host ${candidate.id} conflicts with an existing saved host; neither record was overwritten.`);
      }
    }
    if (defaultHostId !== null && !this.document.importTombstones.includes(defaultHostId)
      && !incomingById.has(defaultHostId) && !existingById.has(defaultHostId)) {
      throw new SavedHostStoreError('The imported default host is missing from the imported host list; nothing was written.');
    }
    const hostsById = new Map(existingById);
    for (const candidate of incomingById.values()) hostsById.set(candidate.id, existingById.get(candidate.id) ?? candidate);
    const applyImportedDefault = !this.document.defaultHostExplicitlySet
      && defaultHostId !== null
      && hostsById.has(defaultHostId);
    this.commit({
      ...this.document,
      hosts: [...hostsById.values()],
      selectedHostId: this.document.selectedHostId
        ?? (defaultHostId !== null && hostsById.has(defaultHostId) ? defaultHostId : null),
      defaultHostId: applyImportedDefault ? defaultHostId : this.document.defaultHostId,
      defaultHostExplicitlySet: this.document.defaultHostExplicitlySet || applyImportedDefault,
      importedHostIds: [...new Set([...this.document.importedHostIds, ...incomingById.keys()])],
    });
  }

  private commit(next: SavedHostDocument<C>): void {
    const validated = validateDocument(next, this.validateCredential);
    this.storage.setItem(SAVED_HOSTS_STORAGE_KEY, JSON.stringify(validated));
    this.document = validated;
  }
}

/** Build the controller target for a host whose key is a platform key handle. */
export function savedHostSshTarget(
  host: SavedHost<SavedHostKeyRef>,
  passphrase?: string | null,
): SshHostTarget {
  if (!host.credentialRef) throw new SavedHostStoreError(`${host.name} has no SSH key.`);
  const credential: SshKeyHandleCredential = {
    kind: 'key-handle',
    handleId: host.credentialRef.handleId,
    ...(host.credentialRef.passphraseRequired && passphrase ? { passphrase } : {}),
  };
  return {
    hostId: host.id,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    credential,
    ...(host.gateway ? { gateway: { ...host.gateway } } : {}),
  };
}

/**
 * Project a saved host into the shared UI's {@link HostEntry} list shape.
 * `name` stays the display name and `id` carries the stable identity, so
 * identity-bearing state (trust pins, the default host) survives a rename.
 */
export function savedHostEntry<C>(host: SavedHost<C>): HostEntry {
  return {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    user: host.username,
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    ...(host.gateway ? { gateway: { ...host.gateway } } : {}),
  };
}

/**
 * The identity of a host-list entry: its stable `id` when the platform owns
 * the host list, otherwise its `Host` alias, which is unique in an
 * `~/.ssh/config` or a synced account list. Every "is this the same host?"
 * decision (default host, connected row, auto-connect) compares this.
 */
export function hostEntryId(host: Pick<HostEntry, 'id' | 'name'>): string {
  return host.id ?? host.name;
}

/** The trust-pin storage key is the stable host ID, never the endpoint. */
export function savedHostTrustStorageKey(hostId: string): string {
  if (!hostId || /[\u0000-\u001f\u007f]/.test(hostId)) {
    throw new SavedHostStoreError('A host trust identity must be a non-empty stable ID.');
  }
  return `pocketshell.ssh.host-key.${hostId}`;
}
