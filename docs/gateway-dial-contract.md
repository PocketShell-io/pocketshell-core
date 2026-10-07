# The gateway dial contract

The portable, effect-free boundary every PocketShell client runs before a
dial does anything: no socket, no broker token, no connection record. The
gateway is a byte transport UNDERNEATH SSH — the platform opens the
gateway's per-host WebSocket and real SSH (keys, userauth, channels) runs
end-to-end through it — so the contract decides how a dial may travel and
refuses everything else. This module owns decisions; the transports stay
platform-owned (browser `gatewayDuplex`/`gatewayToken`, desktop main
process, Android native). Status: portable foundation only — shipping this
does not by itself implement native gateway connectivity on any platform.

## Types

- `SshHostTarget.gateway?: GatewayTransportTarget` — the gateway marker,
  the same type the synced host entry carries (`HostEntry.gateway`,
  `gatewayTransport.ts`). Presence is INTENT: a marker that is null,
  undefined, malformed, or combined with `link` must refuse the dial, never
  fall back to direct SSH (the same rule `sync.hasGatewayMarker` encodes
  for clients that cannot act on the marker). `hostname`/`port` are
  display-only labels for gateway dials.
- The SSH credential is never repurposed: a gateway dial carries the
  host's real SSH key credential (`private-key`, optionally with a
  passphrase for the key, or `key-handle`), and an entirely separate
  short-lived routing token admits the tunnel (below). A `link-token` is
  only ever meaningful to the link capability.
- `SshConnectOptions.expectedHostKey` is retained for every transport. On
  a gateway dial it MUST carry the independently paired fingerprint pin.
- `SshDialPlan` — the classification verdict: `{ kind: 'direct' }`,
  `{ kind: 'link' }`, `{ kind: 'gateway', gateway }` (always the NORMALIZED
  target — consumers never re-normalize a saved record), or
  `{ kind: 'refused', code, message }`.

## Functions and the exact validation order

`classifySshDial(target: SshHostTarget): SshDialPlan` — pure, no I/O:

1. The target must be an object carrying a credential at all.
2. OWN `link` and `gateway` markers are read (`hasOwnProperty`
   semantics, matching `hasGatewayMarker`: an own `undefined` value is
   still intent). Both present is `dial-transport-conflict` — refused even
   when each marker is individually well-formed.
3. A present `gateway` marker must normalize via
   `normalizeGatewayTarget` (canonical `wss://`/`ws://` origin only —
   scheme, userinfo, path, query, fragment are explicit refusals — plus a
   registry-valid device id); anything else is
   `gateway-marker-invalid`. Its credential must then be a usable
   `private-key`/`key-handle`; `password`/`link-token` refuse with
   `gateway-credential-unsupported`.
4. Else a present `link` marker must be a usable link target
   (`link-marker-invalid`) paired with the `link-token` credential
   (`link-credential-mismatch`).
5. Else the dial is direct with a private-key/password/key-handle
   credential. A `link-token` without a link marker refuses
   (`link-token-without-link`); unusable credential shapes refuse
   (`credential-invalid`).

`classifySshConnect(options: SshConnectOptions): SshDialPlan` — the
connect-time boundary every `SshCapability.connect` implementation runs
FIRST: the verdict above, plus the gateway rule that `expectedHostKey`
carry a usable SHA-256 fingerprint pin (`gateway-host-key-unpinned`
otherwise). Gateway mode fails closed: there is no first-contact/TOFU
prompt, because the gateway's `ready.ssh_host_key` advisory can reassure
but never establish trust. Direct and link keep their existing trust
flows.

Refusal messages name the structural fault and never echo the offending
value (no target URLs, device ids, credential material, or peer frame
fields in user-visible errors). The refusal codes are stable strings;
platforms may branch on them for copy/telemetry but must not weaken them
into transport fallbacks: after a broker, transport, or pin failure there
is no direct/link/password fallback either.

## Routing tokens and the broker boundary

The auth frame's token is a short-lived scoped broker JWT — the ROUTING
token — that only ADMITS the tunnel route; the SSH private key still
authenticates against the host's sshd, and public-key userauth remains
mandatory (see `GatewayRoutingToken`). The exchange is platform-owned and
native: mint per dial at the platform's configured trusted account-service
origin (`POST /gateway/token`, no redirects, bounded body, strict
token/expiry response). The account's Google ID/bearer credential never
rides the gateway, the broker origin NEVER comes from a saved gateway
target (the marker's `serverUrl` is only the tunnel endpoint), and no
token or private key persists in core — core holds no network
implementation at all.

## Pairing namespace

Gateway trust records (the independently paired host-key fingerprint pin,
and any per-host gateway key association) MUST live in their own store
keyed by `gatewayHostKeyTrustNamespace(accountId, target)` — the triple
(account, canonical gateway origin, device id). Two accounts, two
gateways, or two devices behind one hostname must never borrow each
other's pin, and a direct-SSH known_hosts entry must never be confused
with a gateway pairing: gateway records never enter the direct
known_hosts namespace. The fingerprint arrives through an independent
host-agent/out-of-band pairing channel, never through the gateway itself.

## What platforms still own

The WebSocket/Duplex transport, frame-size and state bounds, the SSH
engine and key custody, the native broker-token service, pairing
UI/storage, reconnect/generation semantics, and the real acceptance work
(registry-enabled gateway, enrolled agent, loopback sshd with no direct
route, token expiry/remint, wrong-pin and malformed-marker refusals with
no userauth attempt, ordinary direct positives). Core provides the
contract; a green contract suite is not native connectivity.
