import { sha512 } from './bytes';

/**
 * Ed25519 public key from a 32-byte seed (RFC 8032 §5.1.5), in plain BigInt
 * arithmetic so it works where WebCrypto has no Ed25519 (older WebViews). The
 * vault uses it only to check that an uploaded key's public half belongs to
 * its private half — never to sign — so constant time is not a concern here.
 */

const P = 2n ** 255n - 19n;
const D = mod(-121665n * inverse(121666n));
const D2 = mod(2n * D);
const BASE_X = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BASE_Y = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function inverse(a: bigint): bigint {
  return pow(a, P - 2n);
}

/** Extended coordinates (X, Y, Z, T), x = X/Z, y = Y/Z, xy = T/Z. */
type Point = readonly [bigint, bigint, bigint, bigint];

/** The unified addition law for a = -1 (complete, so it also doubles). */
function add([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(t1 * D2 * t2);
  const d = mod(z1 * 2n * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function multiply(scalar: bigint, point: Point): Point {
  let result: Point = [0n, 1n, 1n, 0n];
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}

function encode([x, y, z]: Point): Uint8Array {
  const zi = inverse(z);
  const ax = mod(x * zi);
  let ay = mod(y * zi);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number(ay & 0xffn);
    ay >>= 8n;
  }
  out[31] = (out[31] as number) | (Number(ax & 1n) << 7);
  return out;
}

export async function ed25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new Error('ed25519 seeds are 32 bytes');
  const h = await sha512(seed);
  h[0] = (h[0] as number) & 248;
  h[31] = ((h[31] as number) & 127) | 64;
  let scalar = 0n;
  for (let i = 31; i >= 0; i -= 1) scalar = (scalar << 8n) | BigInt(h[i] as number);
  h.fill(0);
  return encode(multiply(scalar, [BASE_X, BASE_Y, 1n, mod(BASE_X * BASE_Y)]));
}
