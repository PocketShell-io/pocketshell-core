import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bcryptPbkdf, prepareSshPrivateKey, vaultKeyIdForPublicKey } from '../../src/index';

/**
 * Private-key handling against real tools. Every key here is a throwaway
 * generated for this run (ssh-keygen, node:crypto) in a temp dir; nothing is
 * committed. The OpenSSH cases need ssh-keygen (present on CI runners).
 */
const hasSshKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;
const dir = mkdtempSync(join(tmpdir(), 'vault-keys-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function keygen(args: string[]): { file: string; pem: string; pub: string; fingerprint: string } {
  const file = join(dir, `k${counter++}`);
  execFileSync('ssh-keygen', ['-q', '-C', 'throwaway', '-f', file, ...args]);
  const fingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${file}.pub`], { encoding: 'utf8' }).split(' ')[1] as string;
  const pub = readFileSync(`${file}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
  return { file, pem: readFileSync(file, 'utf8'), pub, fingerprint };
}

/** The public key ssh-keygen derives from a PEM we produced — proves the PEM is a valid key file. */
function sshKeygenPublic(pem: string): string {
  const file = join(dir, `out${counter++}`);
  writeFileSync(file, pem, { mode: 0o600 });
  return execFileSync('ssh-keygen', ['-y', '-P', '', '-f', file], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' ');
}

describe.skipIf(!hasSshKeygen)('OpenSSH private keys (ssh-keygen)', () => {
  const cases: Array<[string, string[]]> = [
    ['ed25519', ['-t', 'ed25519']],
    ['ecdsa-256', ['-t', 'ecdsa', '-b', '256']],
    ['ecdsa-384', ['-t', 'ecdsa', '-b', '384']],
    ['ecdsa-521', ['-t', 'ecdsa', '-b', '521']],
    ['rsa-2048', ['-t', 'rsa', '-b', '2048']],
  ];

  for (const [label, args] of cases) {
    it(`${label}: unencrypted → public key, fingerprint, keyId`, async () => {
      const key = keygen([...args, '-N', '']);
      const result = await prepareSshPrivateKey(key.pem);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.key.publicKey).toBe(key.pub);
      expect(result.key.fingerprint).toBe(key.fingerprint);
      expect(result.key.format).toBe('openssh');
      expect(result.key.wasEncrypted).toBe(false);
      expect(result.key.keyId).toHaveLength(22);
      expect(await vaultKeyIdForPublicKey(`${key.pub} comment`)).toBe(result.key.keyId);
    });
  }

  for (const cipher of ['aes256-ctr', 'aes128-ctr', 'aes256-cbc', 'aes256-gcm@openssh.com']) {
    it(`encrypted (${cipher}) → decrypted OpenSSH PEM that ssh-keygen reads without a passphrase`, async () => {
      const passphrase = randomBytes(9).toString('base64url');
      const key = keygen(['-t', 'ed25519', '-N', passphrase, '-Z', cipher, '-a', '4']);
      expect((await prepareSshPrivateKey(key.pem)).kind).toBe('needsPassphrase');
      expect((await prepareSshPrivateKey(key.pem, 'wrong passphrase')).kind).toBe('wrongPassphrase');
      const result = await prepareSshPrivateKey(key.pem, passphrase);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.key.wasEncrypted).toBe(true);
      expect(result.key.fingerprint).toBe(key.fingerprint);
      expect(result.key.pem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
      expect(sshKeygenPublic(result.key.pem)).toBe(key.pub);
      // The decrypted PEM is itself a valid unencrypted vault input with the same identity.
      const again = await prepareSshPrivateKey(result.key.pem);
      expect(again.kind === 'ok' && again.key.keyId).toBe(result.key.keyId);
    });
  }

  it('encrypted RSA-4096 decrypts', async () => {
    const key = keygen(['-t', 'rsa', '-b', '4096', '-N', 'pw', '-a', '2']);
    const result = await prepareSshPrivateKey(key.pem, 'pw');
    expect(result.kind === 'ok' && result.key.fingerprint).toBe(key.fingerprint);
  });
});

describe('PEM private keys (node:crypto)', () => {
  const pemCases = [
    ['rsa pkcs1', () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })],
    ['rsa pkcs8', () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['ec p256 sec1', () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'sec1', format: 'pem' })],
    ['ec p384 pkcs8', () => generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' })],
    ['ed25519 pkcs8', () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })],
  ] as const;

  for (const [label, make] of pemCases) {
    it(`${label}: public key matches ssh-keygen's reading`, async () => {
      const pem = String(make());
      const result = await prepareSshPrivateKey(pem);
      expect(result.kind, JSON.stringify(result)).toBe('ok');
      if (result.kind !== 'ok' || !hasSshKeygen) return;
      expect(sshKeygenPublic(result.key.pem)).toBe(result.key.publicKey);
    });
  }

  it('ed25519 pkcs8 is stored as an OpenSSH key whose public half is node\'s', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const x = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), x]);
    const result = await prepareSshPrivateKey(String(privateKey.export({ type: 'pkcs8', format: 'pem' })));
    expect(result.kind === 'ok' && result.key.publicKey).toBe(`ssh-ed25519 ${blob.toString('base64')}`);
    expect(result.kind === 'ok' && result.key.pem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);
  });

  it('legacy encrypted PEM (Proc-Type, AES-256-CBC) decrypts to a plain PEM', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const plain = String(privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const encrypted = String(privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'legacy pw' }));
    expect(encrypted).toContain('Proc-Type: 4,ENCRYPTED');
    expect((await prepareSshPrivateKey(encrypted)).kind).toBe('needsPassphrase');
    expect((await prepareSshPrivateKey(encrypted, 'nope')).kind).toBe('wrongPassphrase');
    const result = await prepareSshPrivateKey(encrypted, 'legacy pw');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.key.pem).toBe(plain);
    expect(result.key.pem).not.toContain('ENCRYPTED');
  });

  it('refuses what it cannot handle, with a reason instead of a throw', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pkcs8Encrypted = String(privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }));
    expect((await prepareSshPrivateKey(pkcs8Encrypted, 'x')).kind).toBe('unsupported');
    const des = String(privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'des-ede3-cbc', passphrase: 'x' }));
    expect((await prepareSshPrivateKey(des, 'x')).kind).toBe('unsupported');
    expect((await prepareSshPrivateKey('hello')).kind).toBe('invalid');
    expect((await prepareSshPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n')).kind).toBe('invalid');
    expect((await prepareSshPrivateKey('-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----\n')).kind).toBe('unsupported');
  });
});

describe('bcrypt_pbkdf', () => {
  // Cross-check against the npm bcrypt-pbkdf port ssh2 ships, when present.
  let reference: { pbkdf: (...args: unknown[]) => number } | null = null;
  try {
    reference = createRequire(import.meta.url)('bcrypt-pbkdf');
  } catch {
    reference = null;
  }

  it.skipIf(!reference)('matches the reference implementation', async () => {
    for (const [passLen, saltLen, keyLen, rounds] of [[8, 16, 48, 16], [1, 1, 1, 1], [40, 32, 32, 3], [12, 16, 44, 2]] as const) {
      const pass = new Uint8Array(randomBytes(passLen));
      const salt = new Uint8Array(randomBytes(saltLen));
      const expected = new Uint8Array(keyLen);
      reference!.pbkdf(pass, pass.length, salt, salt.length, expected, keyLen, rounds);
      expect(Buffer.from(await bcryptPbkdf(pass, salt, keyLen, rounds)).toString('hex')).toBe(Buffer.from(expected).toString('hex'));
    }
  });
});
