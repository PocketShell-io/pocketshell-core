import { describe, expect, it } from 'vitest';
import { isLinkDial, isLinkTransportTarget } from '../src';
import type { SshHostTarget } from '../src';

describe('link transport target validation', () => {
  it('accepts a well-formed relay target and rejects stripped or empty ones', () => {
    expect(isLinkTransportTarget({ relayUrl: 'wss://relay.example:8765', hostId: 'laptop' })).toBe(true);
    expect(isLinkTransportTarget({ relayUrl: '  wss://relay.example  ', hostId: ' laptop ' })).toBe(true);
    expect(isLinkTransportTarget({ relayUrl: '', hostId: 'laptop' })).toBe(false);
    expect(isLinkTransportTarget({ relayUrl: 'wss://relay.example', hostId: '  ' })).toBe(false);
    expect(isLinkTransportTarget({ relayUrl: 'wss://relay.example' })).toBe(false);
    expect(isLinkTransportTarget('wss://relay.example')).toBe(false);
    expect(isLinkTransportTarget(null)).toBe(false);
  });

  it('marks a dial as link only with both the target and the link-token credential', () => {
    const base = {
      hostId: 'laptop',
      hostname: 'laptop',
      port: 22,
      username: 'alexey',
    } satisfies SshHostTarget;
    expect(
      isLinkDial({
        ...base,
        link: { relayUrl: 'wss://relay.example:8765', hostId: 'laptop' },
        credential: { kind: 'link-token', token: 'secret' },
      }),
    ).toBe(true);
    // link target but an SSH credential: not a link dial (misconfiguration)
    expect(
      isLinkDial({
        ...base,
        link: { relayUrl: 'wss://relay.example:8765', hostId: 'laptop' },
        credential: { kind: 'password', password: 'secret' },
      }),
    ).toBe(false);
    // link-token credential but no link target: same
    expect(isLinkDial({ ...base, credential: { kind: 'link-token', token: 'secret' } })).toBe(false);
    expect(isLinkDial({ ...base, credential: { kind: 'password', password: 'x' } })).toBe(false);
  });
});
