# Settings sync contract

`src/syncMerge.ts` owns the portable settings payload and host selection
policy used by PocketShell clients. The shared cross-client examples live in
[`tests/fixtures/settings-sync-vectors.json`](../tests/fixtures/settings-sync-vectors.json);
the core suite and each client contract suite should run those same vectors.

## Wire format and versioning

The decrypted plaintext is the versionless JSON object `{ "hosts": [...] }`.
It is uploaded in the existing `main` account slot. Each array item is one
host object; unknown JSON fields on a host are part of the data and must survive
a read/merge/write cycle. Private key file contents never belong in this
payload.

There is no plaintext schema-version field today. The integer version returned
by the sync API is an optimistic concurrency revision for the slot, and the
crypto envelope's `v` identifies its encryption format; neither versions the
host payload. Keep writing `{ hosts }` so existing clients continue to read the
same shape. A future incompatible plaintext schema must add an explicit
version and a deliberate migration path; an unsupported version must never be
treated as an empty host list.

`parseSyncPayload` is retained for compatibility with read-only callers. It
returns an empty array for malformed JSON or the wrong top-level shape and
drops entries without a non-empty `name` and `hostname`. That degraded result
is ambiguous with an intentionally empty account and must not drive a write.
Mutating flows must use `parseSyncPayloadResult`: only `{ kind: 'ok', hosts }`
is usable, including an explicit valid `{ "hosts": [] }`. An `invalid` result
has no `hosts` property. Abort assembly and upload on `invalid`, so corrupt or
unrecognized account data cannot silently reset the account.

The strict parser currently accepts only the versionless top-level `hosts`
key. It refuses an explicit `schemaVersion` as `unsupported-version` and
refuses other top-level keys until their read/merge/write behavior is defined.
Unknown fields inside host objects remain forward-compatible and are
preserved. Supporting a future top-level schema requires adding the migration
before accepting that schema.

The strict parser rejects the whole array if any item is not an object with a
non-empty string `name` and `hostname`. It preserves all other fields without
coercion, including nested arrays and objects, so a client that does not
understand a field can still carry it forward.

## The gateway transport marker

A host entry may carry a `gateway` property: the metadata for dialling through
the PocketShell gateway, a transport that initially ships in the browser only.
Sync's job is to carry that property, not to understand it:

- `gateway` is an unknown field for every merge and wire rule above, so a valid
  marker survives merge, strict parsing, and a read/merge/write cycle
  unchanged — and so does a null, malformed, or future-shaped one. Presence is
  preserved verbatim; nothing normalizes it.
- A client that cannot dial the gateway refuses any PRESENT marker
  (`src/sync.ts` `hasGatewayMarker`: an own `gateway` property, value of any
  shape) instead of treating the entry as ordinary SSH. A marker that is null
  or malformed is still gateway intent; coercing it to a plain host would dial
  the wrong transport. An entry that carries both `link` and `gateway` refuses
  too, rather than falling back to the link transport. Every client makes this
  call through ONE shared decision, `unsupportedTransport(entry,
  { gateway, link })` in `src/sync.ts`, passing its real transport
  capabilities, at its dial boundary before any key load or socket; the
  refusal text comes from the same place (`transportRefusalMessage`) so every
  client words it identically.
- The desktop config write-back is the one place a synced entry becomes a file
  on disk, and an OpenSSH block can represent neither the gateway nor a relay
  link — so `coerceHostEntries` asks the same `unsupportedTransport` decision
  with `SSH_CONFIG_TRANSPORTS` (`{ gateway: false, link: false }`), reports
  `transport-unsupported` (with the shared message) for any `gateway`- or
  `link`-marked entry, and the desktop refuses the whole apply before touching
  `~/.ssh/config` (no HostName downgrade, no partial write). The shared connect
  payload carries the marker to the platform boundary for the same reason: the
  store preserves, the platform decides.
- `ConnectionController` (the one dial/trust/reconnect owner) applies the same
  decision again for a gateway target, with `{ gateway:
  capability.gatewayTransport === true, link: false }`, so a marker that slips
  past a platform boundary still refuses before any effect (pocketshell#3086).
  A gateway dial never uses TOFU: the controller skips the trust store, passes
  `expectedHostKey: null`, and accepts the connection only when the platform
  returns `gatewayHostKeyVerified: true` — its receipt that the native pairing
  pin was checked BEFORE userauth. A missing receipt closes the connection; a
  pin mismatch (`HOST_KEY_REJECTED`) is an error, never a trust prompt. Both
  end a reconnect ladder, and every re-dial needs the receipt again.
- A platform reports a gateway refusal by rejecting `connect()` with code
  `GATEWAY_CLOSED` and `data.gatewayCloseCode` (the WS close code; an `error`
  frame is mapped to its documented code). `classifyGatewayDialFailure` in
  `src/gatewayTransport.ts` is the retry matrix: 4401 (sign-in refused), 4403
  (not shared with this account) and 4404 (unknown device) end the ladder
  after that attempt; 4408 (timeout), 4429 (quota) and 4503 (host offline)
  back off within the ordinary retry bounds; any other code keeps the default.
  The classified failure stays on `ConnectionSnapshot.gatewayFailure`
  (`kind`, `closeCode`, `retryable`), so a UI can say "offline" rather than
  "sign-in failed".

## Selection, merge, and conflicts

`checked` contains SSH aliases: the value is a host's `name`, not its
`hostname`. The assembled payload contains only checked aliases, in selection
order, with duplicate ticks ignored. A checked alias found only in the account
uses its account entry. A checked alias found nowhere contributes nothing.
Unticking an alias removes it from the replacement list; this format has no
tombstones and no per-field deletion markers. An empty checked selection is an
explicit empty replacement, so callers should require the user to select hosts
before starting a normal sync.

The tick rule is the same on every client (pocketshell#3072, D43): **every
account host stays selected unless the user explicitly unticked it.** Each
device persists two alias lists, the selection and its explicit unticks
(`SyncSelectionState`). Every clean pull applies `applyAccountToSelection`:
each account alias that is not explicitly unticked joins the selection, even
when this device's own host list (`~/.ssh/config`, the web's synced list, the
phone's saved hosts) also has it. So an untouched Sync now never removes a
host from the account; only an untick does, whether made this session or
persisted from an earlier one. An untick is **one-shot**, not a standing
per-device ban: it is spent by the push that removes the host (`runSyncRound`
reports the remaining unticks as `untickedAliases`), or by a pull that shows
the account no longer holds the alias, so a host another device later adds
back is kept by this device's next untouched Sync now. A push that fails
leaves the untick pending. Signing out forgets all of them: forgetting an
untick can only keep a host in the account, never drop one.

Because every overlapping alias is ticked, this device's explicit local
fields win for it on push (see below). Two devices with a same-named but
different host (two different `nas` boxes) therefore overwrite each other's
account entry rather than dropping it; rename one of them to keep both. The
shared `packages/ui` sync store applies the rule to every account copy it
learns (Check account, the platform's session cache, each round's pulls), so
the Account view shows "remove on sync" only after an explicit untick.

For an alias on both sides, each explicit local property wins over the account
copy, while account properties absent or `undefined` on the local object are
preserved. This gives a client with a smaller host model the same behavior as
Android's `extras` map: its locally-owned `name`, `hostname`, `port`, and `user`
can change without stripping desktop directives such as `IdentityFile`,
`ProxyJump`, and forwards. To get this behavior, adapters must omit fields they
do not own; a synthesized default such as `proxyJump: null` is explicit and
therefore replaces the account value. The desktop's parsed local host includes
its known directives, so those local settings continue to be authoritative.

On a server conflict, clients re-pull and run the same selection/merge policy
against the newest account copy. `src/syncRound.ts` (`runSyncRound`) is that
loop, shared by every client: the shared `packages/ui` sync store (desktop and
web) and Android's settings sync call it with platform `pull`/`push` effects
and never re-implement it. It uses the strict parser, re-bases at most
`SYNC_ROUND_CONFLICT_RETRIES` (3) times, and refuses to upload an empty
assembled set or unreadable account data. Local explicit values continue to win, and
new remote-only fields are carried through. There is no timestamp-based or
field-by-field reconciliation of two explicit conflicting values.

## Shared vectors

The vector file has its own `fixtureSchemaVersion` for test-fixture evolution;
that value is not part of the encrypted wire payload. `mergeCases` cover both
client directions, local-versus-account conflicts, alias-only selection,
account-only restore, and deletion by omission. `autoCheckCases` pin the
tick rule: fresh-device auto-tick, an account alias this device also has,
an explicit untick, and a spent untick. `untickRoundCases` pin the one-shot
untick through a whole round: the push that carries an untick out spends it,
and an alias re-added afterwards is kept. `payloadCases` pin versionless payload
compatibility, valid empty data, and strict refusal of malformed data or an
explicit unsupported schema version.

Keep the same fixture file as the input to core, web, desktop, and Android
contract tests. A client may add runtime-specific integration assertions, but
it should not replace these shared merge expectations with separately
authored copies.
