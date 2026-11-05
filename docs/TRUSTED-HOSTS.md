# Vault-authenticated server enrollment (v1)

The installed trusted client signs in with Google, unlocks the existing vault
with its **strong vault passphrase**, and lists authenticated server descriptors.
Tapping a server rechecks its descriptor before native pin installation and the
existing connection controller's managed-vault-only SSH dial. Gateway directory
keys are advisory and never establish or replace a pin.

## Byte contract

All binary fields use canonical unpadded base64url. All JSON is UTF-8. JavaScript
integers must be safe positive integers. Gateways are canonical WSS origins from
`normalizeGatewayServerUrl`; enrollment uses `wss://gateway.pocketshell.io`.
No comments, fingerprints-only pins, unknown fields or protocol versions are
accepted. The full canonical OpenSSH host key is required.

`slot = "th-" + base64url(SHA256(UTF8(JSON.stringify([serverUrl,deviceId])))[0:16])`

Envelope:

```text
{v:1,accountId:"google:<verified-sub>",vaultId,epoch,serverUrl,deviceId,revision,n,ct}
```

`revision` equals the stored slot version, starting at 1. The optimistic write
request is `{data:JSON.stringify(envelope),version:<previous stored version>}`.
Conflicts must be reread and explicitly reconciled; never replace another
device's descriptor under a stale version.

AAD is the exact UTF-8 bytes of compact JSON, in this array order:

```text
["pocketshell-trusted-host/v1",accountId,vaultId,epoch,serverUrl,deviceId,revision]
```

`n` is a random 12-byte nonce. `ct` is AES-256-GCM ciphertext followed by its
16-byte authentication tag. The key is the SAME existing vault's 32-byte DEK.
Plaintext is a JSON object with exactly:

```text
{hostAlias,username,keyId,sshHostKey,devicePublicKey,status,updatedAt}
```

`devicePublicKey` is raw32-byte Ed25519 identity in base64url. `status` is
`active` or `revoked`; `updatedAt` is UTC ISO with milliseconds. Host alias is
1–128 characters without controls; username is `[A-Za-z_][A-Za-z0-9_.-]{0,63}`.
Active keyId must match the unlocked index's hostAlias binding, which MUST use
`gatewayAuth:"managed"`. No fallback to a phone key, host-key policy or TOFU.

Public interoperability fixture:
`tests/keyVault/fixtures/trusted-host-v1-vector.json`, independently generated
with Node crypto by its neighboring generator. Existing vault format and
Argon2id/HKDF/AES-GCM vectors remain in
`tests/keyVault/fixtures/vault-v1-vectors.json`. The latter contains passphrase,
NFKC normalization, KDF salt/parameters, MK, KEK, AUTH, DEK, header, sealed index,
and key blobs. See `src/keyVault/{format,vaultCrypto,store}.ts`.

## Writes and enrollment

The CLI device-flow login authorizes the account, not its SSH keys. The
enrolling owner independently unlocks the vault locally, obtains its key's
public half and descriptor from the local authoritative endpoint, and installs
the PUBLIC key in the private endpoint's managed authorized_keys. The service
can neither push managed public-key updates nor enable endpoint login.

For a new vault, `POST /cli/vault/initialize` atomically creates header and
verifier. A duplicate/retried request returns409 and the client rereads the
existing header; no overwrite or automatic reset. Then verify AUTH before
encrypted writes. Existing vault creation/unlock cryptography is unchanged.

Vault header index updates use the latest server slot version, decrypt that
latest index, merge only the intended key and alias, reseal with a fresh nonce,
and CAS PUT. On409 reread+decrypt+merge again. Never reuse the stale full index
or silently overwrite an existing alias bound to a different key. Order is:
encrypted key blob → CAS index → authenticated descriptor → recheck local
endpoint/account identity → LOCAL public-key authorization LAST. Publication
failure grants nothing. Local authorization failure leaves an authentic but
unavailable entry; retry repairs it without changing the trust anchor.

## Revocation, rollback and migration

Revocation is a new authenticated `status:"revoked"` descriptor revision,
preserved as a tombstone. Clients persist the highest accepted revision under
account+vault+slot in trusted platform storage and reject rollback or deletion.
Vault generation/account changes invalidate old descriptors. A fresh client
cannot detect historical ciphertext rollback by a malicious storage service
without a separate trusted monotonic anchor; that limitation is explicit.

Revoking the descriptor alone does NOT remove the public key from a host.
Remove local endpoint authorization FIRST, then publish the tombstone. Key
removal refuses new authentications but does NOT terminate existing sessions;
those require explicit close/drain by the endpoint owner. Gateway device revocation can stop routed
sessions but is not a substitute for endpoint authorization removal.

The separate slot leaves the v1 index readable by existing clients (which
otherwise drop unknown binding fields). Existing registry records do not gain
trust automatically. Enroll/update them from their authoritative endpoint or
an independently trusted client. Missing descriptors never authorize reuse of
a legacy local pairing. Vault reset removes these slots with other vault data.

## Threat boundary

Storage, broker or relay compromise alone does not decrypt a strong vault or
forge its authenticated server descriptors. It can deny service or replay old
ciphertexts subject to the local revision floor. Header/key ciphertext permits
OFFLINE passphrase guessing: Argon2id slows guesses; server verifier backoff
does not protect a database dump. A numeric PIN is insufficient. The guarantee
assumes the installed application/bundle and its update chain are trusted. An
actively compromised web server can serve malicious JavaScript and steal an
entered passphrase; web delivery has a different trust boundary.
