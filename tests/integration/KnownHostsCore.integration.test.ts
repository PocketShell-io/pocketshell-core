import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { decodePublicKeyBlob, knownHostsToken, verifyHostKeyPin } from '../../src/knownHostsCore';
import { connectSsh, describeDocker, type SshHandle } from './helpers';

/**
 * Integration tests for core's known-hosts verdicts against a REAL sshd
 * handshake: the `pocketshell-test:ssh` container presents its committed
 * host key, the hostVerifier callback hands over the raw wire blob, and
 * core's `decodePublicKeyBlob` + `verifyHostKeyPin` must classify it the way
 * both clients do during a TOFU accept — unknown before the first pin,
 * trusted after, mismatch for anything else.
 */
describeDocker('KnownHostsCore integration', () => {
  let container: StartedTestContainer | undefined;
  let handle: SshHandle;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:ssh')
      .withExposedPorts(22)
      .start();
    handle = await connectSsh(container.getHost(), container.getMappedPort(22));
  }, 120_000);

  afterAll(async () => {
    handle?.close();
    if (container) await container.stop();
  });

  it('decodes the wire blob the server actually presented', () => {
    const pin = decodePublicKeyBlob(handle.hostKeyBlob);
    // The image ships a committed ed25519 host key.
    expect(pin.keyType).toBe('ssh-ed25519');
    // The known_hosts base64 IS the base64 of the whole blob.
    expect(pin.keyB64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('TOFU: no pin yet reads as unknown, then the captured pin reads as trusted', () => {
    const pin = decodePublicKeyBlob(handle.hostKeyBlob);
    expect(verifyHostKeyPin(undefined, pin.keyType, pin.keyB64)).toBe('unknown');
    expect(verifyHostKeyPin(pin, pin.keyType, pin.keyB64)).toBe('trusted');
  });

  it('a different key under the same pin is a mismatch', () => {
    const pin = decodePublicKeyBlob(handle.hostKeyBlob);
    const flipped =
      pin.keyB64.slice(0, -4) +
      (pin.keyB64.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(verifyHostKeyPin(pin, pin.keyType, flipped)).toBe('mismatch');
    expect(verifyHostKeyPin(pin, 'ssh-rsa', pin.keyB64)).toBe('mismatch');
  });

  it('pins are scoped per host:port — the ephemeral mapped port cannot collide with :22', () => {
    const host = container!.getHost();
    const port = container!.getMappedPort(22);
    // Same host on a different port is a DIFFERENT pin — the regression this
    // token exists for (an image rebuilt on a new base once poisoned every
    // connect to the fixture).
    if (port !== 22) {
      expect(knownHostsToken(host, port)).not.toBe(knownHostsToken(host));
    }
    expect(knownHostsToken(host, port)).toBe(`[${host}]:${port}`);
    expect(knownHostsToken('example.com')).toBe('example.com');
  });
});
