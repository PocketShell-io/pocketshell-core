// Public deterministic interoperability material; never real account data.
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const vault = JSON.parse(readFileSync(new URL('./vault-v1-vectors.json',import.meta.url),'utf8'));
const pins = JSON.parse(readFileSync(new URL('../../fixtures/gateway-host-keys.json',import.meta.url),'utf8'));
const identity = {accountId:'google:fixture-subject',vaultId:vault.vaultId,epoch:1,serverUrl:'wss://gateway.pocketshell.io',deviceId:'fixture-linux',revision:1};
const data = {hostAlias:'Fixture server',username:'orin',keyId:'_LgT2DhVIZFXDq2Ms35vug',sshHostKey:pins.ed25519.line,
  devicePublicKey:Buffer.alloc(32,7).toString('base64url'),status:'active',updatedAt:'2026-11-05T00:00:00.000Z'};
const plaintext = JSON.stringify(data);
const aad = JSON.stringify(['pocketshell-trusted-host/v1',identity.accountId,identity.vaultId,identity.epoch,identity.serverUrl,identity.deviceId,identity.revision]);
const nonce = Buffer.from('606162636465666768696a6b','hex');
const cipher = createCipheriv('aes-256-gcm',Buffer.from(vault.dekHex,'hex'),nonce);
cipher.setAAD(Buffer.from(aad,'utf8'));
const ct = Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final(),cipher.getAuthTag()]);
const envelope = {v:1,...identity,n:nonce.toString('base64url'),ct:ct.toString('base64url')};
const slot = 'th-'+createHash('sha256').update(JSON.stringify([identity.serverUrl,identity.deviceId]),'utf8').digest().subarray(0,16).toString('base64url');
writeFileSync(new URL('./trusted-host-v1-vector.json',import.meta.url),JSON.stringify({comment:'Public throwaway vector; same DEK as vault-v1-vectors.json',dekHex:vault.dekHex,identity,data,plaintext,aad,slot,envelope},null,2)+'\n');
