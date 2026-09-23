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

## Selection, merge, and conflicts

`checked` contains SSH aliases: the value is a host's `name`, not its
`hostname`. The assembled payload contains only checked aliases, in selection
order, with duplicate ticks ignored. A checked alias found only in the account
uses its account entry. A checked alias found nowhere contributes nothing.
Unticking an alias removes it from the replacement list; this format has no
tombstones and no per-field deletion markers. An empty checked selection is an
explicit empty replacement, so callers should require the user to select hosts
before starting a normal sync.

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
against the newest account copy. Local explicit values continue to win, and
new remote-only fields are carried through. There is no timestamp-based or
field-by-field reconciliation of two explicit conflicting values.

## Shared vectors

The vector file has its own `fixtureSchemaVersion` for test-fixture evolution;
that value is not part of the encrypted wire payload. `mergeCases` cover both
client directions, local-versus-account conflicts, alias-only selection,
account-only restore, and deletion by omission. `autoCheckCases` pin the
fresh-device and local-untick behavior. `payloadCases` pin versionless payload
compatibility, valid empty data, and strict refusal of malformed data or an
explicit unsupported schema version.

Keep the same fixture file as the input to core, web, desktop, and Android
contract tests. A client may add runtime-specific integration assertions, but
it should not replace these shared merge expectations with separately
authored copies.
