import { createMD5 } from 'hash-wasm';
import { bcryptPbkdf } from './bcryptPbkdf';
import { ed25519PublicFromSeed } from './ed25519';
import { bytesEqual, concatBytes, fromB64, fromB64url, randomBytes, sha256, subtle, toB64, toB64url, utf8, wipe, type VaultCryptoKey } from './bytes';
import { VAULT_SSH_KEY_TYPES, type VaultSshKeyType } from './types';

/**
 * Just enough SSH private-key handling for the vault: read an OpenSSH or PEM
 * private key (ed25519, ecdsa, rsa), derive its public key, fingerprint and
 * vault keyId, and remove the key's own passphrase so the vault stores a
 * plaintext PEM (design section 3: other clients then only ever need the
 * vault passphrase).
 *
 * Supported inputs:
 *  - `OPENSSH PRIVATE KEY` (openssh-key-v1), unencrypted or encrypted with
 *    bcrypt + aes{128,256}-ctr, aes{128,256}-cbc or aes{128,256}-gcm@openssh.com;
 *  - `RSA PRIVATE KEY` (PKCS#1), `EC PRIVATE KEY` (SEC1), `PRIVATE KEY`
 *    (PKCS#8), unencrypted or legacy-encrypted (`Proc-Type: 4,ENCRYPTED`,
 *    AES-128-CBC or AES-256-CBC).
 * Not yet: chacha20-poly1305 OpenSSH keys, DES-EDE3 and AES-192 legacy PEM, encrypted
 * PKCS#8 (`ENCRYPTED PRIVATE KEY`), security-key (sk-*) and DSA keys.
 */

export type SshKeyFormat = 'openssh' | 'pkcs1' | 'sec1' | 'pkcs8';

/** The public facts of a private key. Nothing secret. */
export interface SshPublicKeyInfo {
  type: VaultSshKeyType;
  /** The SSH wire-format public key blob. */
  publicKeyBlob: Uint8Array;
  /** OpenSSH public key line: `<type> <base64 blob>`. */
  publicKey: string;
  /** `SHA256:<base64, no padding>` — what `ssh-keygen -l` prints. */
  fingerprint: string;
  /** Vault keyId: base64url(SHA-256(blob)[:16]). */
  keyId: string;
}

export interface PreparedSshKey extends SshPublicKeyInfo {
  format: SshKeyFormat;
  /** The plaintext private key PEM to seal into the vault. */
  pem: string;
  /** Whether the input was protected by its own passphrase. */
  wasEncrypted: boolean;
}

export type PrepareSshKeyResult =
  | { kind: 'ok'; key: PreparedSshKey }
  /** The key is encrypted and no key passphrase was given. */
  | { kind: 'needsPassphrase'; format: SshKeyFormat }
  | { kind: 'wrongPassphrase' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'invalid'; message: string };

class KeyError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'invalid' | 'wrongPassphrase',
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new KeyError('invalid', message);
};
const unsupported = (message: string): never => {
  throw new KeyError('unsupported', message);
};

// ── SSH wire format ──────────────────────────────────────────────────────

class WireReader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  u32(): number {
    if (this.offset + 4 > this.buf.length) invalid('truncated key data');
    const b = this.buf;
    const o = this.offset;
    this.offset += 4;
    return (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0;
  }

  bytes(length: number): Uint8Array {
    if (this.offset + length > this.buf.length) invalid('truncated key data');
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  string(): Uint8Array {
    return this.bytes(this.u32());
  }

  text(): string {
    return new TextDecoder().decode(this.string());
  }

  rest(): Uint8Array {
    return this.bytes(this.buf.length - this.offset);
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }
}

function u32be(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function sshString(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  return concatBytes(u32be(bytes.length), bytes);
}

/** An SSH mpint from an unsigned big-endian integer. */
function sshMpint(unsigned: Uint8Array): Uint8Array {
  let start = 0;
  while (start < unsigned.length && unsigned[start] === 0) start += 1;
  let body = unsigned.subarray(start);
  if (body.length > 0 && ((body[0] as number) & 0x80) !== 0) body = concatBytes(Uint8Array.of(0), body);
  return sshString(body);
}

// ── DER ──────────────────────────────────────────────────────────────────

interface Der {
  tag: number;
  content: Uint8Array;
}

function readDer(buf: Uint8Array, offset: number): { node: Der; next: number } {
  if (offset + 2 > buf.length) invalid('truncated DER');
  const tag = buf[offset] as number;
  let length = buf[offset + 1] as number;
  let pos = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || pos + count > buf.length) invalid('bad DER length');
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + (buf[pos + i] as number);
    pos += count;
  }
  if (pos + length > buf.length) invalid('truncated DER');
  return { node: { tag, content: buf.subarray(pos, pos + length) }, next: pos + length };
}

function derChildren(node: Der): Der[] {
  const out: Der[] = [];
  let offset = 0;
  while (offset < node.content.length) {
    const { node: child, next } = readDer(node.content, offset);
    out.push(child);
    offset = next;
  }
  return out;
}

function derRoot(buf: Uint8Array, tag: number): Der {
  const { node, next } = readDer(buf, 0);
  if (node.tag !== tag || next !== buf.length) invalid('malformed DER');
  return node;
}

function derOid(node: Der | undefined): string {
  if (!node || node.tag !== 0x06 || node.content.length === 0) return invalid('expected an OID');
  const bytes = node.content;
  const first = bytes[0] as number;
  const parts = [Math.min(2, Math.floor(first / 40)), first - Math.min(2, Math.floor(first / 40)) * 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    value = value * 128 + ((bytes[i] as number) & 0x7f);
    if (((bytes[i] as number) & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

function need(node: Der | undefined, tag: number): Der {
  if (!node || node.tag !== tag) return invalid('malformed key structure');
  return node;
}

const OID_RSA = '1.2.840.113549.1.1.1';
const OID_EC = '1.2.840.10045.2.1';
const OID_ED25519 = '1.3.101.112';
const CURVES: Record<string, { type: VaultSshKeyType; ident: string; jwk: string; size: number; oidDer: Uint8Array }> = {
  '1.2.840.10045.3.1.7': {
    type: 'ecdsa-sha2-nistp256',
    ident: 'nistp256',
    jwk: 'P-256',
    size: 32,
    oidDer: Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07),
  },
  '1.3.132.0.34': { type: 'ecdsa-sha2-nistp384', ident: 'nistp384', jwk: 'P-384', size: 48, oidDer: Uint8Array.of(0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22) },
  '1.3.132.0.35': { type: 'ecdsa-sha2-nistp521', ident: 'nistp521', jwk: 'P-521', size: 66, oidDer: Uint8Array.of(0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23) },
};
const OID_EC_DER = Uint8Array.of(0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);

function curveByIdent(ident: string): string {
  const oid = Object.keys(CURVES).find((key) => CURVES[key]?.ident === ident);
  return oid ?? unsupported(`unsupported EC curve ${ident}`);
}

// ── private/public consistency ───────────────────────────────────────────
//
// An uploaded key's public half must belong to its private half: the keyId,
// fingerprint and host bindings all come from the public half, so a spliced
// file (someone else's public key, our private key) must never get in.

const mismatch = (): never => invalid('the private key does not match its public key');

function bigUnsigned(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function checkRsa(n: Uint8Array, e: Uint8Array, d: Uint8Array, p: Uint8Array, q: Uint8Array): void {
  const [N, E, D, P, Q] = [n, e, d, p, q].map(bigUnsigned) as [bigint, bigint, bigint, bigint, bigint];
  if (P < 2n || Q < 2n || N !== P * Q) mismatch();
  if ((E * D) % (P - 1n) !== 1n || (E * D) % (Q - 1n) !== 1n) mismatch();
}

function derTlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  const length = n < 0x80 ? Uint8Array.of(n) : n < 0x100 ? Uint8Array.of(0x81, n) : Uint8Array.of(0x82, n >> 8, n & 0xff);
  return concatBytes(Uint8Array.of(tag), length, content);
}

/** The uncompressed public point for EC private scalar `d`, derived by WebCrypto (never trusted from the file). */
async function ecPointFromPrivate(curveOid: string, d: Uint8Array): Promise<Uint8Array> {
  const curve = CURVES[curveOid] ?? unsupported(`unsupported EC curve ${curveOid}`);
  let start = 0;
  while (start < d.length - 1 && d[start] === 0) start += 1;
  const scalar = d.subarray(start);
  if (scalar.length > curve.size) mismatch();
  const fixed = new Uint8Array(curve.size);
  fixed.set(scalar, curve.size - scalar.length);
  // PKCS#8 without the optional public key, so the platform must compute it.
  const sec1 = derTlv(0x30, concatBytes(Uint8Array.of(0x02, 0x01, 0x01), derTlv(0x04, fixed)));
  const pkcs8 = derTlv(
    0x30,
    concatBytes(Uint8Array.of(0x02, 0x01, 0x00), derTlv(0x30, concatBytes(OID_EC_DER, curve.oidDer)), derTlv(0x04, sec1)),
  );
  wipe(fixed);
  let jwk: { x?: string; y?: string };
  try {
    const key = await subtle().importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: curve.jwk }, true, ['sign']);
    jwk = (await subtle().exportKey('jwk', key)) as { x?: string; y?: string };
  } catch {
    // The platform could not import the key (curve not offered): we cannot
    // check it here, which is not the same as a mismatch.
    return unsupported(`this device cannot check ${curve.ident} keys; upload it from another device`);
  } finally {
    wipe(pkcs8);
    wipe(sec1);
  }
  const x = typeof jwk.x === 'string' ? fromB64url(jwk.x) : null;
  const y = typeof jwk.y === 'string' ? fromB64url(jwk.y) : null;
  if (!x || !y || x.length !== curve.size || y.length !== curve.size) return mismatch();
  return concatBytes(Uint8Array.of(0x04), x, y);
}

// ── PEM ──────────────────────────────────────────────────────────────────

interface Pem {
  label: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function parsePem(text: string): Pem {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([\s\S]*?)\r?\n?-----END \1-----/.exec(text);
  if (!match) return invalid('not a PEM private key');
  const label = match[1] as string;
  const headers: Record<string, string> = {};
  const lines = (match[2] as string).split(/\r?\n/).map((line) => line.trim());
  let i = 0;
  if (lines.some((line) => /^[A-Za-z-]+:/.test(line))) {
    for (; i < lines.length && lines[i] !== ''; i += 1) {
      const header = /^([A-Za-z-]+):\s*(.*)$/.exec(lines[i] as string);
      if (!header) return invalid('malformed PEM header');
      headers[header[1] as string] = header[2] as string;
    }
  }
  const b64 = lines.slice(i).join('');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return invalid('malformed PEM body');
  let body: Uint8Array;
  try {
    body = fromB64(b64);
  } catch {
    return invalid('malformed PEM body');
  }
  return { label, headers, body };
}

function emitPem(label: string, body: Uint8Array): string {
  const b64 = toB64(body);
  const lines: string[] = [];
  const width = label === 'OPENSSH PRIVATE KEY' ? 70 : 64;
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ── public key info ──────────────────────────────────────────────────────

/** Fingerprint, OpenSSH line and vault keyId for an SSH public key blob. */
export async function sshPublicKeyInfo(blob: Uint8Array): Promise<SshPublicKeyInfo> {
  const type = new WireReader(blob).text();
  if (!(VAULT_SSH_KEY_TYPES as readonly string[]).includes(type)) {
    return unsupported(`unsupported key type ${JSON.stringify(type.slice(0, 40))}`);
  }
  const digest = await sha256(blob);
  return {
    type: type as VaultSshKeyType,
    publicKeyBlob: blob,
    publicKey: `${type} ${toB64(blob)}`,
    fingerprint: `SHA256:${toB64(digest).replace(/=+$/, '')}`,
    keyId: toB64url(digest.subarray(0, 16)),
  };
}

/** The vault keyId of an OpenSSH public key line (`<type> <base64> [comment]`), or null. */
export async function vaultKeyIdForPublicKey(line: string): Promise<string | null> {
  const b64 = line.trim().split(/\s+/)[1];
  if (!b64) return null;
  try {
    return (await sshPublicKeyInfo(fromB64(b64))).keyId;
  } catch {
    return null;
  }
}

function rsaBlob(e: Uint8Array, n: Uint8Array): Uint8Array {
  return concatBytes(sshString('ssh-rsa'), sshMpint(e), sshMpint(n));
}

function ecBlob(curveOid: string, point: Uint8Array): Uint8Array {
  const curve = CURVES[curveOid] ?? unsupported(`unsupported EC curve ${curveOid}`);
  if (point[0] !== 0x04) unsupported('compressed EC public keys are not supported');
  return concatBytes(sshString(curve.type), sshString(curve.ident), sshString(point));
}

function ed25519Blob(pub: Uint8Array): Uint8Array {
  if (pub.length !== 32) invalid('bad ed25519 public key');
  return concatBytes(sshString('ssh-ed25519'), sshString(pub));
}

function pkcs1Blob(der: Uint8Array): Uint8Array {
  const items = derChildren(derRoot(der, 0x30));
  if (items.length < 9) invalid('malformed RSA private key');
  const [n, e, d, p, q] = [1, 2, 3, 4, 5].map((i) => need(items[i], 0x02).content) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  checkRsa(n, e, d, p, q);
  return rsaBlob(e, n);
}

function bitStringBytes(node: Der): Uint8Array {
  if (node.content[0] !== 0) invalid('unexpected BIT STRING padding');
  return node.content.subarray(1);
}

async function sec1Blob(der: Uint8Array, outerCurve: string | null): Promise<Uint8Array> {
  const items = derChildren(derRoot(der, 0x30));
  const d = need(items[1], 0x04).content;
  let curve = outerCurve;
  let point: Uint8Array | null = null;
  for (const item of items.slice(2)) {
    if (item.tag === 0xa0) curve = derOid(derChildren(item)[0]);
    if (item.tag === 0xa1) point = bitStringBytes(need(derChildren(item)[0], 0x03));
  }
  if (!curve) return invalid('EC private key names no curve');
  const derived = await ecPointFromPrivate(curve, d);
  if (point && !bytesEqual(point, derived)) mismatch();
  return ecBlob(curve, derived);
}

async function pkcs8Blob(der: Uint8Array): Promise<Uint8Array> {
  const items = derChildren(derRoot(der, 0x30));
  const alg = derChildren(need(items[1], 0x30));
  const oid = derOid(alg[0]);
  const inner = need(items[2], 0x04).content;
  if (oid === OID_RSA) return pkcs1Blob(inner);
  if (oid === OID_EC) return sec1Blob(inner, alg[1] ? derOid(alg[1]) : null);
  if (oid === OID_ED25519) {
    const seed = derRoot(inner, 0x04).content;
    if (seed.length !== 32) invalid('bad ed25519 private key');
    const derived = await ed25519PublicFromSeed(seed);
    const embedded = items.slice(3).find((item) => item.tag === 0x81);
    if (embedded && !bytesEqual(bitStringBytes({ tag: 0x03, content: embedded.content }), derived)) mismatch();
    return ed25519Blob(derived);
  }
  return unsupported(`unsupported PKCS#8 key algorithm ${oid}`);
}

// ── OpenSSH (openssh-key-v1) ─────────────────────────────────────────────

const OPENSSH_MAGIC = utf8('openssh-key-v1\0');

interface OpenSshContainer {
  cipher: string;
  kdf: string;
  kdfOptions: Uint8Array;
  publicBlob: Uint8Array;
  privateSection: Uint8Array;
  /** Bytes after the private section (the GCM tag for aes-gcm). */
  trailer: Uint8Array;
}

function parseOpenSsh(body: Uint8Array): OpenSshContainer {
  if (!bytesEqual(body.subarray(0, OPENSSH_MAGIC.length), OPENSSH_MAGIC)) invalid('not an openssh-key-v1 key');
  const reader = new WireReader(body.subarray(OPENSSH_MAGIC.length));
  const cipher = reader.text();
  const kdf = reader.text();
  const kdfOptions = reader.string();
  if (reader.u32() !== 1) unsupported('OpenSSH key files with more than one key are not supported');
  const publicBlob = reader.string();
  const privateSection = reader.string();
  return { cipher, kdf, kdfOptions, publicBlob, privateSection, trailer: reader.rest() };
}

const OPENSSH_CIPHERS: Record<string, { mode: 'ctr' | 'cbc' | 'gcm'; keyLen: number; ivLen: number }> = {
  'aes128-ctr': { mode: 'ctr', keyLen: 16, ivLen: 16 },
  'aes256-ctr': { mode: 'ctr', keyLen: 32, ivLen: 16 },
  'aes128-cbc': { mode: 'cbc', keyLen: 16, ivLen: 16 },
  'aes256-cbc': { mode: 'cbc', keyLen: 32, ivLen: 16 },
  'aes128-gcm@openssh.com': { mode: 'gcm', keyLen: 16, ivLen: 12 },
  'aes256-gcm@openssh.com': { mode: 'gcm', keyLen: 32, ivLen: 12 },
};

/** AES-CBC decrypt WITHOUT padding removal (WebCrypto only does PKCS#7). */
async function aesCbcDecryptRaw(key: VaultCryptoKey, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  if (ct.length === 0 || ct.length % 16 !== 0) return invalid('bad CBC ciphertext length');
  // Append one block that decrypts to a full PKCS#7 pad block: E(0x10…0x10 ⊕ C_last).
  const last = ct.subarray(ct.length - 16);
  const pad = new Uint8Array(16).fill(16);
  const extra = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: last }, key, pad)).subarray(0, 16);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, key, concatBytes(ct, extra)));
}

async function decryptOpenSshSection(container: OpenSshContainer, passphrase: string): Promise<Uint8Array> {
  const cipher = OPENSSH_CIPHERS[container.cipher] ?? unsupported(`unsupported OpenSSH key cipher ${container.cipher}`);
  if (container.kdf !== 'bcrypt') unsupported(`unsupported OpenSSH key KDF ${container.kdf}`);
  const options = new WireReader(container.kdfOptions);
  const salt = options.string();
  const rounds = options.u32();
  if (rounds < 1 || rounds > 1024) invalid('implausible bcrypt rounds');
  const pass = utf8(passphrase);
  if (pass.length === 0) throw new KeyError('wrongPassphrase', 'empty key passphrase');
  const derived = await bcryptPbkdf(pass, salt, cipher.keyLen + cipher.ivLen, rounds);
  wipe(pass);
  const keyBytes = derived.subarray(0, cipher.keyLen);
  const iv = derived.subarray(cipher.keyLen);
  try {
    if (cipher.mode === 'ctr') {
      const key = await subtle().importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt']);
      return new Uint8Array(await subtle().decrypt({ name: 'AES-CTR', counter: iv, length: 128 }, key, container.privateSection));
    }
    if (cipher.mode === 'cbc') {
      const key = await subtle().importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
      return await aesCbcDecryptRaw(key, iv, container.privateSection);
    }
    const tag = container.trailer.subarray(0, 16);
    if (tag.length !== 16) invalid('missing GCM tag');
    const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    try {
      return new Uint8Array(
        await subtle().decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, concatBytes(container.privateSection, tag)),
      );
    } catch {
      throw new KeyError('wrongPassphrase', 'wrong key passphrase');
    }
  } finally {
    wipe(derived);
  }
}

/**
 * Check the decrypted private section: the checkints (a wrong passphrase),
 * then that its key IS the header's public key — the public fields match and
 * the public half derives from the private half.
 */
async function checkOpenSshSection(section: Uint8Array, publicBlob: Uint8Array): Promise<void> {
  const reader = new WireReader(section);
  const check1 = reader.u32();
  const check2 = reader.u32();
  if (check1 !== check2) throw new KeyError('wrongPassphrase', 'wrong key passphrase');
  const type = reader.text();
  const pub = new WireReader(publicBlob);
  if (type !== pub.text()) invalid('private and public key types differ');
  if (type === 'ssh-ed25519') {
    const blobKey = pub.string();
    const key = reader.string();
    const priv = reader.string();
    if (priv.length !== 64 || !bytesEqual(key, blobKey) || !bytesEqual(priv.subarray(32), key)) mismatch();
    if (!bytesEqual(await ed25519PublicFromSeed(priv.subarray(0, 32)), key)) mismatch();
  } else if (type.startsWith('ecdsa-sha2-')) {
    const blobIdent = pub.text();
    const blobPoint = pub.string();
    const ident = reader.text();
    const point = reader.string();
    const d = reader.string();
    if (ident !== blobIdent || !bytesEqual(point, blobPoint)) mismatch();
    if (!bytesEqual(await ecPointFromPrivate(curveByIdent(ident), d), point)) mismatch();
  } else if (type === 'ssh-rsa') {
    const blobE = pub.string();
    const blobN = pub.string();
    const [n, e, d] = [reader.string(), reader.string(), reader.string()];
    reader.string(); // iqmp
    const [p, q] = [reader.string(), reader.string()];
    if (bigUnsigned(n) !== bigUnsigned(blobN) || bigUnsigned(e) !== bigUnsigned(blobE)) mismatch();
    checkRsa(n, e, d, p, q);
  } else {
    unsupported(`unsupported key type ${type}`);
  }
}

function buildUnencryptedOpenSsh(publicBlob: Uint8Array, section: Uint8Array): string {
  // The private section keeps its padding (1, 2, 3, …); a multiple of 16 is a
  // multiple of the `none` cipher's 8-byte block too.
  const body = concatBytes(
    OPENSSH_MAGIC,
    sshString('none'),
    sshString('none'),
    sshString(new Uint8Array(0)),
    u32be(1),
    sshString(publicBlob),
    sshString(section),
  );
  return emitPem('OPENSSH PRIVATE KEY', body);
}

/** Re-wrap a PKCS#8 ed25519 key as an unencrypted openssh-key-v1 file. */
function ed25519Pkcs8ToOpenSsh(der: Uint8Array, publicBlob: Uint8Array): string {
  const items = derChildren(derRoot(der, 0x30));
  const seed = derRoot(need(items[2], 0x04).content, 0x04).content;
  if (seed.length !== 32) invalid('bad ed25519 private key');
  const pub = new WireReader(publicBlob);
  pub.text();
  const point = pub.string();
  const check = randomBytes(4);
  let section = concatBytes(
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(point),
    sshString(concatBytes(seed, point)),
    sshString(''),
  );
  const pad = (8 - (section.length % 8)) % 8;
  section = concatBytes(section, Uint8Array.from({ length: pad }, (_, i) => i + 1));
  const pem = buildUnencryptedOpenSsh(publicBlob, section);
  wipe(section);
  return pem;
}

// ── legacy encrypted PEM (Proc-Type: 4,ENCRYPTED) ────────────────────────

/** OpenSSL EVP_BytesToKey(MD5, pass, salt = iv[:8], count = 1). */
async function evpBytesToKey(pass: Uint8Array, salt: Uint8Array, length: number): Promise<Uint8Array> {
  const md5 = await createMD5();
  let out = new Uint8Array(0);
  let prev = new Uint8Array(0);
  while (out.length < length) {
    md5.init();
    md5.update(concatBytes(prev, pass, salt));
    prev = md5.digest('binary');
    out = concatBytes(out, prev);
  }
  return out.subarray(0, length);
}

async function decryptLegacyPem(pem: Pem, passphrase: string): Promise<Uint8Array> {
  const info = /^(AES-(128|192|256)-CBC|DES-EDE3-CBC|DES-CBC),([0-9A-Fa-f]+)$/.exec(pem.headers['DEK-Info'] ?? '');
  if (!info) return unsupported('unsupported PEM encryption');
  if (!info[2] || info[2] === '192') return unsupported(`${info[1]} encrypted PEM keys are not supported; re-encrypt with ssh-keygen -p`);
  const keyLen = Number(info[2]) / 8;
  const ivHex = info[3] as string;
  if (ivHex.length !== 32) invalid('bad DEK-Info IV');
  const iv = Uint8Array.from(ivHex.match(/../g) as string[], (h) => parseInt(h, 16));
  const pass = utf8(passphrase);
  const keyBytes = await evpBytesToKey(pass, iv.subarray(0, 8), keyLen);
  wipe(pass);
  try {
    const key = await subtle().importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, key, pem.body));
  } catch (error) {
    if (error instanceof KeyError) throw error;
    throw new KeyError('wrongPassphrase', 'wrong key passphrase');
  } finally {
    wipe(keyBytes);
  }
}

// ── entry point ──────────────────────────────────────────────────────────

const PEM_FORMATS: Record<string, SshKeyFormat> = {
  'OPENSSH PRIVATE KEY': 'openssh',
  'RSA PRIVATE KEY': 'pkcs1',
  'EC PRIVATE KEY': 'sec1',
  'PRIVATE KEY': 'pkcs8',
};

async function derBlob(format: SshKeyFormat, der: Uint8Array): Promise<Uint8Array> {
  if (format === 'pkcs1') return pkcs1Blob(der);
  if (format === 'sec1') return await sec1Blob(der, null);
  return pkcs8Blob(der);
}

/**
 * Read a private key file, remove its own passphrase if it has one, and
 * return the plaintext PEM plus its public facts. Never throws for bad
 * input — the result says why. `keyPassphrase` is ignored for an
 * unencrypted key.
 */
export async function prepareSshPrivateKey(text: string, keyPassphrase?: string | null): Promise<PrepareSshKeyResult> {
  try {
    if (typeof text !== 'string' || text.length > 64 * 1024) return { kind: 'invalid', message: 'not a private key file' };
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text)) {
      return { kind: 'unsupported', message: 'encrypted PKCS#8 keys are not supported yet; convert with ssh-keygen -p' };
    }
    const pem = parsePem(text);
    const format = PEM_FORMATS[pem.label] ?? unsupported(`unsupported key file (${pem.label})`);
    const passphrase = keyPassphrase ?? '';

    if (format === 'openssh') {
      const container = parseOpenSsh(pem.body);
      const info = await sshPublicKeyInfo(container.publicBlob);
      if (container.cipher === 'none') {
        if (container.kdf !== 'none') invalid('unencrypted OpenSSH key with a KDF');
        await checkOpenSshSection(container.privateSection, container.publicBlob);
        return { kind: 'ok', key: { ...info, format, pem: emitPem(pem.label, pem.body), wasEncrypted: false } };
      }
      if (passphrase === '') return { kind: 'needsPassphrase', format };
      const section = await decryptOpenSshSection(container, passphrase);
      await checkOpenSshSection(section, container.publicBlob);
      const plain = buildUnencryptedOpenSsh(container.publicBlob, section);
      wipe(section);
      return { kind: 'ok', key: { ...info, format, pem: plain, wasEncrypted: true } };
    }

    if (pem.headers['Proc-Type'] !== undefined) {
      if (!/^4,\s*ENCRYPTED$/.test(pem.headers['Proc-Type'])) invalid('unexpected PEM Proc-Type');
      if (passphrase === '') return { kind: 'needsPassphrase', format };
      const der = await decryptLegacyPem(pem, passphrase);
      let blob: Uint8Array;
      try {
        blob = await derBlob(format, der);
      } catch (error) {
        // A wrong passphrase that happened to leave valid padding yields garbage DER.
        if (error instanceof KeyError && error.kind === 'invalid') throw new KeyError('wrongPassphrase', 'wrong key passphrase');
        throw error;
      }
      const info = await sshPublicKeyInfo(blob);
      const plain = emitPem(pem.label, der);
      wipe(der);
      return { kind: 'ok', key: { ...info, format, pem: plain, wasEncrypted: true } };
    }

    const info = await sshPublicKeyInfo(await derBlob(format, pem.body));
    // OpenSSH cannot read PKCS#8 ed25519, so the vault stores it as an OpenSSH key.
    const stored = info.type === 'ssh-ed25519' ? ed25519Pkcs8ToOpenSsh(pem.body, info.publicKeyBlob) : emitPem(pem.label, pem.body);
    return { kind: 'ok', key: { ...info, format, pem: stored, wasEncrypted: false } };
  } catch (error) {
    if (error instanceof KeyError) {
      return error.kind === 'wrongPassphrase' ? { kind: 'wrongPassphrase' } : { kind: error.kind, message: error.message };
    }
    throw error;
  }
}
