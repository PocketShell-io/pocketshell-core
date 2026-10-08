# The gateway dial contract

The portable, effect-free boundary every PocketShell client MUST run before
a dial does anything — no socket, no broker token, no connection record —
once that client's platform adopts the gateway transport. This is the
adoption contract, not a description of current calls: this module owns the
decisions, but no controller or existing capability invokes it yet, and the
transports stay platform-owned (browser `gatewayDuplex`/`gatewayToken`,
desktop main process, Android native). The gateway is a byte transport
UNDERNEATH SSH — the platform opens the gateway's per-host WebSocket and
real SSH (keys, userauth, channels) runs end-to-end through it — so the
contract decides how a dial may travel and refuses everything else. Status:
portable foundation only — shipping this does not by itself implement
native gateway connectivity on any platform.

## Types

- `SshHostTarget.gateway?: GatewayTransportTarget` — the gateway marker,
  the same type the synced host entry carries (`HostEntry.gateway`,
  `gatewayTransport.ts`). Presence is INTENT: a marker that is null,
  undefined, malformed, or combined with `link` must refuse the dial, never
  fall back to direct SSH (the same rule `sync.hasGatewayMarker` encodes
  for clients that cannot act on the marker). `hostname`/`port` are
  display-only labels for gateway dials.
- `SshDialPolicy` — the trusted caller's transport policy (e.g.
  `allowInsecureLoopbackWs`). Its fields are platform configuration,
  supplied by the code that owns the dial from its own trusted settings;
  they must never be derived from the saved gateway marker, from sync
  data, or from anything a gateway delivered — a marker can never widen
  its own transport policy.
- The SSH credential is never repurposed: a gateway dial carries the
  host's real SSH key credential (`private-key`, optionally with a
  string-or-absent `passphrase` for the key, or `key-handle`), and an
  entirely separate short-lived routing token admits the tunnel (below). A
  `link-token` is only ever meaningful to the link capability.
- `SshConnectOptions.expectedHostKey` is retained for every transport. On
  a gateway dial it MUST carry the independently provisioned host-key pin
  in its canonical persisted form (below).
- `SshDialPlan` — the classification verdict: `{ kind: 'direct' }`,
  `{ kind: 'link' }`, `{ kind: 'gateway', gateway }` (always the NORMALIZED
  target — consumers never re-normalize a saved record), or
  `{ kind: 'refused', code, message }`.

## Functions and the exact validation order

`classifySshDial(target: SshHostTarget, policy?: SshDialPolicy): SshDialPlan`
— pure, no I/O:

1. The target must be an object carrying a credential at all.
2. OWN `link` and `gateway` markers are read (`hasOwnProperty`
   semantics, matching `hasGatewayMarker`: an own `undefined` value is
   still intent). Both present is `dial-transport-conflict` — refused even
   when each marker is individually well-formed.
3. A present `gateway` marker must normalize via `normalizeGatewayTarget`
   (canonical origin only — scheme, userinfo, path, dot-segments, query,
   fragment, and control characters are explicit refusals, checked on the
   ORIGINAL text before URL canonicalization, plus a registry-valid device
   id); anything else is `gateway-marker-invalid`.
4. The normalized origin must be SECURE: `wss://` by default. An
   unencrypted `ws://` origin refuses with `gateway-transport-insecure`
   unless `policy.allowInsecureLoopbackWs` is true AND the origin points
   at a loopback host (localhost, 127.0.0.0/8, `::1`) — the development
   allowance is caller configuration and loopback-only, never a field of
   the saved marker.
5. The gateway dial's credential must be a usable `private-key` (nonempty
   key material, and a `passphrase` that is absent, null, or a string) or
   `key-handle`; `password`/`link-token` refuse with
   `gateway-credential-unsupported`, broken shapes with
   `credential-invalid`.
6. Else a present `link` marker must be a usable link target
   (`link-marker-invalid`) paired with the `link-token` credential
   (`link-credential-mismatch`).
7. Else the dial is direct with a private-key/password/key-handle
   credential. A `link-token` without a link marker refuses
   (`link-token-without-link`); unusable credential shapes refuse
   (`credential-invalid`).

`classifySshConnect(options: SshConnectOptions, policy?: SshDialPolicy):
SshDialPlan` — the connect-time boundary every `SshCapability.connect`
implementation MUST run FIRST once its platform adopts the transport: the
verdict above, plus the gateway pin rule. Gateway mode fails closed: there
is no first-contact/TOFU prompt, because the gateway's `ready.ssh_host_key`
advisory can reassure but never establish trust. Direct and link keep
their existing trust flows.

The gateway pin rule — `expectedHostKey` must be a pin this boundary
supports, in its canonical persisted form, or the dial refuses with
`gateway-host-key-unpinned`:

- `kind: 'sha256-fingerprint'` whose `fingerprintSha256` is EXACTLY the
  canonical OpenSSH display form `SHA256:` + 43 unpadded base64 chars —
  the output of `normalizeSha256Fingerprint`. The digest body is
  case-sensitive and never case-folded; a full `ssh-keygen -lf` line, a
  padded or lowercase-prefixed spelling is not the canonical form and
  refuses (pairing flows persist the canonical form at pairing time).
- `kind: 'wire-key'` with that same canonical fingerprint plus
  structurally valid known_hosts fields: a `keyType` label and a base64
  key blob whose embedded RFC 4251 type string IS that label (decoded
  without crypto).
- Anything else — an unknown kind, a well-formed fingerprint under an
  unsupported kind, a malformed wire blob — refuses. The canonical
  requirement is the handoff: platform code compares persisted
  fingerprints as exact strings (`hostKeyTrustCore`), so the boundary
  accepts only the form such a comparison can honor. That the pin was
  provisioned independently of the gateway stays a platform
  responsibility this pure contract cannot verify.

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
native: mint per dial at the platform's FIXED trusted broker issuer — the
account-service origin the platform configures and binds to the signed-in
account (`POST /gateway/token`, no redirects, bounded body). The issuer
never comes from a saved gateway target, sync data, or a redirect, and
when the exchange fails the dial fails: the raw Google ID/bearer
credential is never sent to the gateway as a fallback. The broker
response's expiry is mandatory — a missing, non-finite, or already-passed
`expiresEpochMs` fails closed (the type admits no null). The account's
Google ID/bearer credential never rides the gateway (the marker's
`serverUrl` is only the tunnel endpoint), and no token or private key
persists in core — core holds no network implementation at all.

## Pairing namespace

Gateway trust records (the independently paired host-key fingerprint pin,
and any per-host gateway key association) MUST live in their own store
keyed by `gatewayHostKeyTrustNamespace(accountId, target)` — the triple
(account, canonical gateway origin, device id). Two accounts, two
gateways, or two devices behind one hostname must never borrow each
other's pin, and a direct-SSH known_hosts entry must never be confused
with a gateway pairing: gateway records never enter the direct
known_hosts namespace. The fingerprint arrives through an independent
host-agent/out-of-band pairing channel, never through the gateway itself,
and is persisted in the canonical form the connect boundary requires.

## What platforms still own

The WebSocket/Duplex transport, frame-size and state bounds, the SSH
engine and key custody, the native broker-token service, pairing
UI/storage, reconnect/generation semantics, and the real acceptance work
(registry-enabled gateway, enrolled agent, loopback sshd with no direct
route, token expiry/remint, wrong-pin and malformed-marker refusals with
no userauth attempt, ordinary direct positives). Core provides the
contract; a green contract suite is not native connectivity.
