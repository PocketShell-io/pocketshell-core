import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prepareSshPrivateKey } from '../../src/index';

/**
 * Review of 6490d2d, item 5: an uploaded key's public half must belong to its
 * private half (keyId, fingerprint and bindings all come from the public
 * half). Throwaway keys only, made at test time.
 */
const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;
const dir = mkdtempSync(join(tmpdir(), 'vault-review-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function opensshParts(pem: string) {
  const body = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  let o = 15;
  const str = () => {
    const n = body.readUInt32BE(o);
    const out = body.subarray(o + 4, o + 4 + n);
    o += 4 + n;
    return out;
  };
  const cipher = str();
  const kdf = str();
  const opts = str();
  o += 4;
  const pub = str();
  const priv = str();
  return { head: body.subarray(0, 15), cipher, kdf, opts, pub, priv };
}

function rebuildOpenssh(parts: ReturnType<typeof opensshParts>, pub: Buffer): string {
  const s = (b: Buffer) => Buffer.concat([Buffer.alloc(4, 0), b]).fill(0, 0, 0).writeUInt32BE(b.length, 0) && Buffer.concat([Buffer.from([b.length >>> 24, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255]), b]);
  const one = Buffer.from([0, 0, 0, 1]);
  const body = Buffer.concat([parts.head, s(parts.cipher), s(parts.kdf), s(parts.opts), one, s(pub), s(parts.priv)]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

describe('review #5: the public key must match the private key', () => {
  it.skipIf(!hasSshKeygen)('an OpenSSH key with another key’s public blob is refused (ed25519, ecdsa, rsa)', async () => {
    for (const args of [['-t', 'ed25519'], ['-t', 'ecdsa', '-b', '256'], ['-t', 'rsa', '-b', '2048']]) {
      const make = (name: string) => {
        execFileSync('ssh-keygen', ['-q', '-N', '', '-f', join(dir, name), ...args]);
        return readFileSync(join(dir, name), 'utf8');
      };
      const tag = args.join('');
      const victim = opensshParts(make(`victim${tag}`));
      const attacker = opensshParts(make(`attacker${tag}`));
      const spliced = rebuildOpenssh(attacker, victim.pub);
      expect((await prepareSshPrivateKey(spliced)).kind, tag).toBe('invalid');
    }
  });

  it('a PKCS#8 / SEC1 key whose embedded public key is someone else’s is refused', async () => {
    const a = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const b = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const derA = Buffer.from(a.privateKey.export({ type: 'sec1', format: 'der' }));
    const derB = Buffer.from(b.privateKey.export({ type: 'sec1', format: 'der' }));
    const spliced = Buffer.concat([derA.subarray(0, derA.length - 65), derB.subarray(derB.length - 65)]);
    const pem = `-----BEGIN EC PRIVATE KEY-----\n${spliced.toString('base64')}\n-----END EC PRIVATE KEY-----\n`;
    expect((await prepareSshPrivateKey(pem)).kind).toBe('invalid');

    const edA = generateKeyPairSync('ed25519');
    const edB = generateKeyPairSync('ed25519');
    const seed = Buffer.from(edA.privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32);
    const pubB = Buffer.from(edB.publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    // PKCS#8 v2 (OneAsymmetricKey) with an embedded [1] public key.
    const v2 = Buffer.concat([
      Buffer.from('3051020101300506032b657004220420', 'hex'),
      seed,
      Buffer.from('812100', 'hex'),
      pubB,
    ]);
    const edPem = `-----BEGIN PRIVATE KEY-----\n${v2.toString('base64')}\n-----END PRIVATE KEY-----\n`;
    expect((await prepareSshPrivateKey(edPem)).kind).toBe('invalid');
  });

  it('an RSA key whose modulus is not p*q is refused', async () => {
    const der = Buffer.from(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'der' }));
    // Flip one byte inside n (it starts right after the version INTEGER).
    der[20] ^= 1;
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${der.toString('base64')}\n-----END RSA PRIVATE KEY-----\n`;
    expect((await prepareSshPrivateKey(pem)).kind).toBe('invalid');
  });

});


describe('review 2 (B): an EC key this platform cannot import is unsupported, not a mismatch', () => {
  it('reports unsupported when WebCrypto refuses the curve', async () => {
    const pem = String(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'sec1', format: 'pem' }));
    const subtle = globalThis.crypto.subtle;
    const original = subtle.importKey.bind(subtle);
    const spy = vi.spyOn(subtle, 'importKey').mockImplementation(((format: string, data: unknown, alg: unknown, ...rest: unknown[]) => {
      if (typeof alg === 'object' && alg !== null && (alg as { name?: string }).name === 'ECDSA') {
        return Promise.reject(new Error('NotSupportedError'));
      }
      return (original as (...args: unknown[]) => Promise<CryptoKey>)(format, data, alg, ...rest);
    }) as typeof subtle.importKey);
    try {
      expect((await prepareSshPrivateKey(pem)).kind).toBe('unsupported');
    } finally {
      spy.mockRestore();
    }
  });
});
