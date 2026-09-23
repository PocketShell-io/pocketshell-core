import {
  verifyHostKeyPin,
  type HostKeyPin,
  type KnownHostsVerdict,
} from './knownHostsCore';

/**
 * A persisted host pin. `sha256-fingerprint` reads existing Android
 * `trustedHostKeySha256` rows without changing their identity; `wire-key` is
 * the key-blob form used by shared known-hosts stores.
 */
export type HostKeyTrustPin =
  | { kind: 'sha256-fingerprint'; fingerprintSha256: string }
  | ({ kind: 'wire-key'; fingerprintSha256: string } & HostKeyPin);

export interface PresentedHostKey extends HostKeyPin {
  fingerprintSha256: string;
}

/** Adapt the old Android host row's SHA256 value without rewriting it. */
export function fromAndroidTrustedHostKeySha256(value: string | null | undefined): HostKeyTrustPin | null {
  return value == null || value.trim().length === 0
    ? null
    : { kind: 'sha256-fingerprint', fingerprintSha256: value };
}

/** Preserve the fingerprint value when an adapter writes to the old Android column. */
export function toAndroidTrustedHostKeySha256(pin: HostKeyTrustPin): string {
  return pin.fingerprintSha256;
}

/** Compare a presented key using the exact format each persisted pin stores. */
export function verifyHostKeyTrustPin(
  pin: HostKeyTrustPin | null | undefined,
  presented: PresentedHostKey,
): KnownHostsVerdict {
  if (pin == null) return 'unknown';
  if (pin.kind === 'sha256-fingerprint') {
    return pin.fingerprintSha256 === presented.fingerprintSha256 ? 'trusted' : 'mismatch';
  }
  return verifyHostKeyPin(pin, presented.keyType, presented.keyB64);
}

/** Keep a legacy fingerprint record in its original format when users rotate it. */
export function acceptedHostKeyPin(
  previous: HostKeyTrustPin | null,
  presented: PresentedHostKey,
): HostKeyTrustPin {
  return previous?.kind === 'sha256-fingerprint'
    ? { kind: 'sha256-fingerprint', fingerprintSha256: presented.fingerprintSha256 }
    : { kind: 'wire-key', ...presented };
}
