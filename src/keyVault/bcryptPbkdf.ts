import { sha512 } from './bytes';
import { BLOWFISH_P, BLOWFISH_S } from './blowfishTables';

/*
 * bcrypt_pbkdf, the KDF of encrypted OpenSSH private keys (`kdfname bcrypt`).
 * A port of OpenBSD bcrypt_pbkdf.c and the Blowfish parts of blowfish.c,
 * word-based so it does not depend on the host's byte order.
 *
 * Blowfish block cipher for OpenBSD
 * Copyright 1997 Niels Provos <provos@physnet.uni-hamburg.de>
 * All rights reserved.
 * Implementation advice by David Mazieres <dm@lcs.mit.edu>.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met: 1. Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 * notice, this list of conditions and the following disclaimer in the
 * documentation and/or other materials provided with the distribution.
 * 3. The name of the author may not be used to endorse or promote products
 * derived from this software without specific prior written permission.
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
 * IMPLIED WARRANTIES ARE DISCLAIMED.
 *
 * bcrypt_pbkdf: Copyright (c) 2013 Ted Unangst <tedu@openbsd.org>
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.
 */

class Blowfish {
  readonly p = Uint32Array.from(BLOWFISH_P);
  readonly s = Uint32Array.from(BLOWFISH_S);
  private readonly block = new Uint32Array(2);

  private f(x: number): number {
    const s = this.s;
    return ((((s[x >>> 24] as number) + (s[256 + ((x >>> 16) & 0xff)] as number)) ^
      (s[512 + ((x >>> 8) & 0xff)] as number)) + (s[768 + (x & 0xff)] as number)) >>> 0;
  }

  /** Encrypt `this.block` in place. */
  encipher(): void {
    const p = this.p;
    let xl = (this.block[0] as number) ^ (p[0] as number);
    let xr = this.block[1] as number;
    for (let i = 1; i < 16; i += 2) {
      xr = (xr ^ this.f(xl >>> 0) ^ (p[i] as number)) >>> 0;
      xl = (xl ^ this.f(xr) ^ (p[i + 1] as number)) >>> 0;
    }
    this.block[0] = xr ^ (p[17] as number);
    this.block[1] = xl;
  }

  /** Blowfish_expand0state: key schedule from the key alone. */
  expand0(key: Uint8Array): void {
    const cursor = { j: 0 };
    for (let i = 0; i < 18; i += 1) this.p[i] = (this.p[i] as number) ^ streamToWord(key, cursor);
    this.block.fill(0);
    for (let i = 0; i < 18; i += 2) {
      this.encipher();
      this.p[i] = this.block[0] as number;
      this.p[i + 1] = this.block[1] as number;
    }
    for (let i = 0; i < 1024; i += 2) {
      this.encipher();
      this.s[i] = this.block[0] as number;
      this.s[i + 1] = this.block[1] as number;
    }
  }

  /** Blowfish_expandstate: key schedule salted with `data`. */
  expand(data: Uint8Array, key: Uint8Array): void {
    const keyCursor = { j: 0 };
    for (let i = 0; i < 18; i += 1) this.p[i] = (this.p[i] as number) ^ streamToWord(key, keyCursor);
    const dataCursor = { j: 0 };
    this.block.fill(0);
    for (let i = 0; i < 18; i += 2) {
      this.block[0] = (this.block[0] as number) ^ streamToWord(data, dataCursor);
      this.block[1] = (this.block[1] as number) ^ streamToWord(data, dataCursor);
      this.encipher();
      this.p[i] = this.block[0] as number;
      this.p[i + 1] = this.block[1] as number;
    }
    for (let i = 0; i < 1024; i += 2) {
      this.block[0] = (this.block[0] as number) ^ streamToWord(data, dataCursor);
      this.block[1] = (this.block[1] as number) ^ streamToWord(data, dataCursor);
      this.encipher();
      this.s[i] = this.block[0] as number;
      this.s[i + 1] = this.block[1] as number;
    }
  }

  encryptWords(words: Uint32Array): void {
    for (let i = 0; i < words.length; i += 2) {
      this.block[0] = words[i] as number;
      this.block[1] = words[i + 1] as number;
      this.encipher();
      words[i] = this.block[0] as number;
      words[i + 1] = this.block[1] as number;
    }
  }
}

function streamToWord(data: Uint8Array, cursor: { j: number }): number {
  let word = 0;
  for (let i = 0; i < 4; i += 1) {
    if (cursor.j >= data.length) cursor.j = 0;
    word = ((word << 8) | (data[cursor.j] as number)) >>> 0;
    cursor.j += 1;
  }
  return word;
}

const MAGIC = new TextEncoder().encode('OxychromaticBlowfishSwatDynamite');

/** bcrypt_hash: 32 bytes from SHA-512(pass) and SHA-512(salt). */
function bcryptHash(sha2pass: Uint8Array, sha2salt: Uint8Array): Uint8Array {
  const state = new Blowfish();
  state.expand(sha2salt, sha2pass);
  for (let i = 0; i < 64; i += 1) {
    state.expand0(sha2salt);
    state.expand0(sha2pass);
  }
  const cdata = new Uint32Array(8);
  const cursor = { j: 0 };
  for (let i = 0; i < 8; i += 1) cdata[i] = streamToWord(MAGIC, cursor);
  for (let i = 0; i < 64; i += 1) state.encryptWords(cdata);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i += 1) {
    const word = cdata[i] as number;
    out[4 * i + 3] = word >>> 24;
    out[4 * i + 2] = (word >>> 16) & 0xff;
    out[4 * i + 1] = (word >>> 8) & 0xff;
    out[4 * i] = word & 0xff;
  }
  return out;
}

/** bcrypt_pbkdf(pass, salt, rounds) → `keyLength` bytes, as OpenSSH derives key+IV. */
export async function bcryptPbkdf(
  pass: Uint8Array,
  salt: Uint8Array,
  keyLength: number,
  rounds: number,
): Promise<Uint8Array> {
  if (rounds < 1 || pass.length === 0 || salt.length === 0 || keyLength <= 0 || keyLength > 1024 || salt.length > 1 << 20) {
    throw new Error('bcrypt_pbkdf: invalid parameters');
  }
  const key = new Uint8Array(keyLength);
  const stride = Math.ceil(keyLength / 32);
  let amt = Math.ceil(keyLength / stride);
  const sha2pass = await sha512(pass);
  const countsalt = new Uint8Array(salt.length + 4);
  countsalt.set(salt);
  let remaining = keyLength;
  for (let count = 1; remaining > 0; count += 1) {
    countsalt[salt.length] = (count >>> 24) & 0xff;
    countsalt[salt.length + 1] = (count >>> 16) & 0xff;
    countsalt[salt.length + 2] = (count >>> 8) & 0xff;
    countsalt[salt.length + 3] = count & 0xff;
    let tmp = bcryptHash(sha2pass, await sha512(countsalt));
    const out = Uint8Array.from(tmp);
    for (let i = 1; i < rounds; i += 1) {
      // Each round is ~64 Blowfish key schedules: yield so a UI thread keeps painting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      tmp = bcryptHash(sha2pass, await sha512(tmp));
      for (let j = 0; j < 32; j += 1) out[j] = (out[j] as number) ^ (tmp[j] as number);
    }
    amt = Math.min(amt, remaining);
    let i = 0;
    for (; i < amt; i += 1) {
      const dest = i * stride + (count - 1);
      if (dest >= keyLength) break;
      key[dest] = out[i] as number;
    }
    remaining -= i;
  }
  return key;
}
