/**
 * Byte helpers for the key vault: strict base64url, UTF-8, and the WebCrypto
 * handle. Internal to src/keyVault — not re-exported from the package index.
 */

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** Base64url without padding (vault format: every binary value). */
export function toB64url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strict base64url decode: the url alphabet only, no padding, no whitespace,
 * and a canonical encoding (re-encoding gives back the input). Returns null
 * instead of throwing, so parsers can reject cleanly.
 */
export function fromB64url(text: string): Uint8Array | null {
  if (typeof text !== 'string' || !B64URL_RE.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let bytes: Uint8Array;
  try {
    bytes = fromB64(padded);
  } catch {
    return null;
  }
  return toB64url(bytes) === text ? bytes : null;
}

/** Standard base64 with padding. */
export function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Standard base64 decode; throws on malformed input. */
export function fromB64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Strict UTF-8 decode (malformed bytes throw). */
export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Overwrite a buffer holding secret material (best effort in JS). */
export function wipe(bytes: Uint8Array | null | undefined): void {
  if (bytes) bytes.fill(0);
}

export function randomBytes(length: number): Uint8Array {
  return webCrypto().getRandomValues(new Uint8Array(length));
}

/** Thrown when the platform has no WebCrypto (e.g. an insecure http origin). */
export class VaultCryptoUnavailableError extends Error {
  constructor() {
    super('This device has no WebCrypto (crypto.subtle); the key vault needs a secure context.');
    this.name = 'VaultCryptoUnavailableError';
  }
}

/**
 * An opaque WebCrypto key handle. Declared here rather than borrowed from the
 * DOM lib so core's sources typecheck the same in every consumer (DOM or not);
 * a DOM `CryptoKey` satisfies it.
 */
export interface VaultCryptoKey {
  readonly type: string;
  readonly extractable: boolean;
}

/** The slice of `crypto.subtle` the vault uses (browsers in secure contexts, Electron, Node 19+, WebView). */
export interface VaultSubtleCrypto {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: Uint8Array | Record<string, unknown>,
    algorithm: string | Record<string, unknown>,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<VaultCryptoKey>;
  exportKey(format: string, key: VaultCryptoKey): Promise<ArrayBuffer | Record<string, unknown>>;
  deriveBits(algorithm: Record<string, unknown>, baseKey: VaultCryptoKey, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: Record<string, unknown>, key: VaultCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: Record<string, unknown>, key: VaultCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
}

interface VaultCrypto {
  readonly subtle?: VaultSubtleCrypto;
  getRandomValues<T extends Uint8Array>(array: T): T;
}

function webCrypto(): VaultCrypto {
  const api = (globalThis as unknown as { crypto?: VaultCrypto }).crypto;
  if (!api) throw new VaultCryptoUnavailableError();
  return api;
}

export function subtle(): VaultSubtleCrypto {
  const api = webCrypto().subtle;
  if (!api) throw new VaultCryptoUnavailableError();
  return api;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-512', data));
}
