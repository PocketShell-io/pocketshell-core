/** Account-authenticated SSH trust, separate from the v1 vault index. */
import { isValidGatewayDeviceId, normalizeGatewayServerUrl } from '../gatewayTransport';
import { parseGatewayHostPin } from '../gatewayDevices';
import { fromB64url, fromUtf8, subtle, toB64url, utf8, type VaultCryptoKey } from './bytes';
import { isId16 } from './format';
import { open, seal } from './vaultCrypto';

export interface TrustedHostTarget { serverUrl: string; deviceId: string }
export interface TrustedHostIdentity extends TrustedHostTarget {
  accountId: string; vaultId: string; epoch: number; revision: number;
}
export interface TrustedHostData {
  hostAlias: string; username: string; keyId: string; sshHostKey: string;
  devicePublicKey: string; status: 'active' | 'revoked'; updatedAt: string;
}
export interface TrustedHostEnvelope extends TrustedHostIdentity { v: 1; n: string; ct: string }
export interface TrustedHostRecord extends TrustedHostIdentity, TrustedHostData { version: number }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, names: string[]) => Object.keys(v).sort().join(',') === [...names].sort().join(',');
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
export function validTrustedHostIdentity(v: TrustedHostIdentity): boolean {
  return typeof v.accountId === 'string' && /^google:[0-9A-Za-z_-]{1,128}$/.test(v.accountId) && isId16(v.vaultId)
    && positive(v.epoch) && positive(v.revision) && isValidGatewayDeviceId(v.deviceId)
    && typeof v.serverUrl === 'string' && v.serverUrl.startsWith('wss://') && normalizeGatewayServerUrl(v.serverUrl) === v.serverUrl;
}
export function parseTrustedHostData(v: unknown): TrustedHostData | null {
  if (!record(v) || !exact(v, ['hostAlias','username','keyId','sshHostKey','devicePublicKey','status','updatedAt'])) return null;
  if (typeof v.hostAlias !== 'string' || v.hostAlias.length < 1 || v.hostAlias.length > 128 || /[\u0000-\u001f\u007f]/.test(v.hostAlias)
    || v.hostAlias === '__proto__' || typeof v.username !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(v.username)
    || !isId16(v.keyId) || typeof v.sshHostKey !== 'string' || v.sshHostKey.length > 4096
    || typeof v.devicePublicKey !== 'string' || fromB64url(v.devicePublicKey)?.length !== 32
    || (v.status !== 'active' && v.status !== 'revoked') || typeof v.updatedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.updatedAt) || !Number.isFinite(Date.parse(v.updatedAt))) return null;
  const pin = parseGatewayHostPin(v.sshHostKey);
  if (!pin || pin.kind !== 'host-key' || pin.line !== v.sshHostKey) return null;
  return v as unknown as TrustedHostData;
}
export async function trustedHostSlot(target: TrustedHostTarget): Promise<string> {
  if (normalizeGatewayServerUrl(target.serverUrl) !== target.serverUrl || !target.serverUrl.startsWith('wss://') || !isValidGatewayDeviceId(target.deviceId)) throw new Error('invalid trusted host target');
  const hash = new Uint8Array(await subtle().digest('SHA-256', utf8(JSON.stringify([target.serverUrl, target.deviceId]))));
  return `th-${toB64url(hash.subarray(0,16))}`;
}
export function trustedHostAad(v: TrustedHostIdentity): string {
  if (!validTrustedHostIdentity(v)) throw new Error('invalid trusted host identity');
  return JSON.stringify(['pocketshell-trusted-host/v1',v.accountId,v.vaultId,v.epoch,v.serverUrl,v.deviceId,v.revision]);
}
export function parseTrustedHostEnvelope(text: string): TrustedHostEnvelope | null {
  if (text.length > 8192) return null;
  let v: unknown; try { v = JSON.parse(text); } catch { return null; }
  if (!record(v) || !exact(v,['v','accountId','vaultId','epoch','serverUrl','deviceId','revision','n','ct']) || v.v !== 1) return null;
  const e = v as unknown as TrustedHostEnvelope;
  if (!validTrustedHostIdentity(e) || typeof e.n !== 'string' || fromB64url(e.n)?.length !== 12 || typeof e.ct !== 'string' || (fromB64url(e.ct)?.length ?? 0) < 16) return null;
  return e;
}
export async function sealTrustedHost(dek: VaultCryptoKey, identity: TrustedHostIdentity, data: TrustedHostData, nonce?: Uint8Array): Promise<TrustedHostEnvelope> {
  if (!parseTrustedHostData(data)) throw new Error('invalid trusted host data');
  return {v:1,...identity,...await seal(dek,utf8(JSON.stringify(data)),trustedHostAad(identity),nonce)};
}
export async function openTrustedHost(dek: VaultCryptoKey, envelope: TrustedHostEnvelope): Promise<TrustedHostData | null> {
  const bytes = await open(dek,envelope,trustedHostAad(envelope));
  if (!bytes) return null;
  try { return parseTrustedHostData(JSON.parse(fromUtf8(bytes))); } catch { return null; }
}
