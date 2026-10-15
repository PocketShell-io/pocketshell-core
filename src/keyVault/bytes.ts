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
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Thrown when the platform has no WebCrypto (e.g. an insecure http origin). */
export class VaultCryptoUnavailableError extends Error {
  constructor() {
    super('This device has no WebCrypto (crypto.subtle); the key vault needs a secure context.');
    this.name = 'VaultCryptoUnavailableError';
  }
}

export function subtle(): CoreSubtleCrypto {
  const api = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (!api) throw new VaultCryptoUnavailableError();
  return api;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-512', data));
}
