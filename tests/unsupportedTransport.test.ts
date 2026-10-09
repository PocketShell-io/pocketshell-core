import { describe, expect, it } from 'vitest';
import {
  transportRefusalMessage,
  unsupportedTransport,
  type TransportCapabilities,
  type TransportRefusalReason,
} from '../src';

/**
 * The shared dial-boundary decision (#3059, pocketshell-desktop#8,
 * pocketshell-web#4, pocketshell#3073): one function every client asks before
 * any key load or socket, so a gateway- or link-marked host can never be
 * dialled as ordinary SSH to its display hostname.
 */

const NONE: TransportCapabilities = { gateway: false, link: false };
const LINK_ONLY: TransportCapabilities = { gateway: false, link: true };
const GATEWAY_ONLY: TransportCapabilities = { gateway: true, link: false };
const BOTH: TransportCapabilities = { gateway: true, link: true };

const VALID_GATEWAY = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'device-1' };
const VALID_LINK = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };

function host(extra: Record<string, unknown> = {}): object {
  return { name: 'gw', hostname: '10.0.0.5', port: 22, user: 'root', ...extra };
}

function reasonOf(entry: object, caps: TransportCapabilities): TransportRefusalReason | null {
  const d = unsupportedTransport(entry, caps);
  return d.refused ? d.reason : null;
}

const GATEWAY_SHAPES: Array<[string, unknown]> = [
  ['valid', VALID_GATEWAY],
  ['null', null],
  ['malformed string', 'wss://surprise'],
  ['malformed object', { nope: true }],
  ['malformed array', [VALID_GATEWAY]],
  ['undefined', undefined],
  ['insecure path-carrying url', { serverUrl: 'wss://gateway.example/path?token=x', deviceId: 'device-1' }],
];

describe('unsupportedTransport — ordinary hosts', () => {
  it.each([NONE, LINK_ONLY, GATEWAY_ONLY, BOTH])('never refuses a host with neither marker (%o)', (caps) => {
    expect(unsupportedTransport(host(), caps)).toEqual({ refused: false });
  });

  it('ignores inherited markers and look-alike keys', () => {
    const inherited = Object.create({ gateway: VALID_GATEWAY, link: VALID_LINK }) as object;
    expect(unsupportedTransport(inherited, NONE)).toEqual({ refused: false });
    expect(unsupportedTransport(host({ gateways: null, links: null }), NONE)).toEqual({ refused: false });
  });
});

describe('unsupportedTransport — gateway marker', () => {
  it.each(GATEWAY_SHAPES)('refuses a %s gateway marker on a client without gateway support', (_label, marker) => {
    for (const caps of [NONE, LINK_ONLY]) {
      const d = unsupportedTransport(host({ gateway: marker }), caps);
      expect(d).toEqual({
        refused: true,
        reason: 'gateway-unsupported',
        message: '“gw” is reached through the PocketShell gateway, which this device can\'t connect through yet. Nothing was dialled.',
      });
    }
  });

  it('allows only a VALID gateway marker on a gateway-capable client', () => {
    expect(unsupportedTransport(host({ gateway: VALID_GATEWAY }), GATEWAY_ONLY)).toEqual({ refused: false });
    expect(unsupportedTransport(host({ gateway: VALID_GATEWAY }), BOTH)).toEqual({ refused: false });
    for (const [, marker] of GATEWAY_SHAPES.filter(([l]) => l !== 'valid')) {
      expect(reasonOf(host({ gateway: marker }), GATEWAY_ONLY)).toBe('gateway-invalid');
      expect(reasonOf(host({ gateway: marker }), BOTH)).toBe('gateway-invalid');
    }
  });

  it('does not normalize or mutate the marker it inspects', () => {
    const marker = { serverUrl: ' https://Gateway.PocketShell.io ', deviceId: ' device-1 ' };
    const entry = host({ gateway: marker });
    const before = JSON.stringify(entry);
    unsupportedTransport(entry, BOTH);
    expect(JSON.stringify(entry)).toBe(before);
  });
});

describe('unsupportedTransport — link + gateway conflict', () => {
  it.each(GATEWAY_SHAPES)('refuses link + %s gateway under every capability set', (_label, marker) => {
    for (const linkMarker of [VALID_LINK, null, 'junk']) {
      const entry = host({ link: linkMarker, gateway: marker });
      expect(reasonOf(entry, NONE)).toBe('gateway-unsupported');
      // A link-capable client must NOT ride the link transport for it.
      expect(reasonOf(entry, LINK_ONLY)).toBe('gateway-unsupported');
      expect(reasonOf(entry, GATEWAY_ONLY)).toBe('link-and-gateway');
      expect(reasonOf(entry, BOTH)).toBe('link-and-gateway');
    }
  });
});

describe('unsupportedTransport — link marker alone', () => {
  it.each([VALID_LINK, null, 'wss://relay', { relayUrl: '', hostId: 'x' }])(
    'refuses link marker %o on a client without a link transport',
    (marker) => {
      for (const caps of [NONE, GATEWAY_ONLY]) {
        const d = unsupportedTransport(host({ link: marker }), caps);
        expect(d).toEqual({
          refused: true,
          reason: 'link-unsupported',
          message: '“gw” is reached through a PocketShell relay link, which this device can\'t connect through yet. Nothing was dialled.',
        });
      }
    },
  );

  it('allows a valid link marker on a link-capable client and refuses a malformed one', () => {
    expect(unsupportedTransport(host({ link: VALID_LINK }), LINK_ONLY)).toEqual({ refused: false });
    expect(unsupportedTransport(host({ link: VALID_LINK }), BOTH)).toEqual({ refused: false });
    for (const marker of [null, undefined, 'wss://relay', { relayUrl: 'wss://r' }, { relayUrl: '', hostId: 'x' }]) {
      expect(reasonOf(host({ link: marker }), LINK_ONLY)).toBe('link-invalid');
    }
  });
});

describe('unsupportedTransport — connect payloads and labels', () => {
  it('decides on a connect payload (no name) exactly as on the entry', () => {
    const payload = { host: '10.0.0.5', port: 22, user: 'root', gateway: null };
    const d = unsupportedTransport(payload, NONE);
    expect(d.refused && d.reason).toBe('gateway-unsupported');
    expect(d.refused && d.message).toBe(
      "This host is reached through the PocketShell gateway, which this device can't connect through yet. Nothing was dialled.",
    );
  });

  it('uses an explicit label over the entry name, and null for no name', () => {
    const entry = host({ link: VALID_LINK });
    const named = unsupportedTransport(entry, NONE, 'box');
    expect(named.refused && named.message.startsWith('“box” ')).toBe(true);
    const anon = unsupportedTransport(entry, NONE, null);
    expect(anon.refused && anon.message.startsWith('This host ')).toBe(true);
  });

  it('exports one fixed message per reason, each saying nothing was dialled', () => {
    const reasons: TransportRefusalReason[] = [
      'gateway-unsupported',
      'gateway-invalid',
      'link-and-gateway',
      'link-unsupported',
      'link-invalid',
    ];
    const texts = reasons.map((r) => transportRefusalMessage(r, 'gw'));
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) {
      expect(t.startsWith('“gw” ')).toBe(true);
      expect(t.endsWith('Nothing was dialled.')).toBe(true);
    }
  });
});
