// SPDX-License-Identifier: LGPL-3.0-or-later
//
// Port of the Sec-MS-GEC v2 token generator from rany2/edge-tts:
//   https://github.com/rany2/edge-tts  (edge_tts/drm.py)
//   Copyright (C) rany and edge-tts contributors
//   Licensed under the GNU Lesser General Public License v3.0 or later.
//   Source of the file this was ported from is available at the URL above;
//   this repository's copy carries the provenance and license statements
//   required by LGPL-3.0 §4/§6 (see THIRD_PARTY_NOTICES.md).
//
// This file is licensed to the project under LGPL-3.0-or-later and is the only
// such file in pi-web; everything else in the repository is MIT. It is used
// here as an independently replaceable module (see installEdgeTtsSynthUrl() in
// ./edge-tts-endpoint.ts) and can be swapped out for an upstream implementation
// without touching the rest of the codebase.
import { Buffer } from "node:buffer";

/**
 * Sec-MS-GEC v2 token for Microsoft Edge's "Read Aloud" service.
 *
 * Microsoft moved the service to a v2 token in the `"<cs64>-<sha256>"` format
 * (16 hex + "-" + 64 hex). The `msedge-tts` package still emits the older v1
 * single-SHA256 token, which the service now rejects with HTTP 403 — the reason
 * every synthesis in pi-web failed and playback fell back to the browser's
 * built-in voices.
 *
 * This is a faithful port of the reference implementation in
 * `edge_tts/drm.py` from https://github.com/rany2/edge-tts. The
 * algorithm is a modified SHA-256 plus a custom "CS64" mixer. BigInteger
 * arithmetic is used throughout so the 64-bit intermediate products stay exact.
 */

const MASK = BigInt(0xFFFFFFFF);
const WIN_EPOCH = BigInt(11644473600);
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

const SHA256_INITIAL = [
  BigInt(0x6A09E667), BigInt(0xBB67AE85), BigInt(0x3C6EF372), BigInt(0xA54FF53A),
  BigInt(0x510E527F), BigInt(0x9B05688C), BigInt(0x1F83D9AB), BigInt(0x5BE0CD19),
];
const SHA256_STATE = [
  BigInt(0xFD9FBEA2), BigInt(0x91243CE7), BigInt(0xBE499094), BigInt(0xCD2E1E0A),
  BigInt(0x6C006F49), BigInt(0x04BD35AB), BigInt(0xFEB0A7E4), BigInt(0x03EFFBD2),
];
const SHA256_SCHEDULE = [
  BigInt(0xEB24BF9E), BigInt(0x1558691F), BigInt(0xA0C09EE2), BigInt(0x0CFA32BA),
  BigInt(0xA622EE8C), BigInt(0xD1DD9491), BigInt(0xC0DD25A0), BigInt(0xF9E70AB6),
  BigInt(0xF0C31573), BigInt(0x7058CE4E), BigInt(0x7188E606), BigInt(0x00E5AB33),
  BigInt(0xD258B060), BigInt(0x72766564),
];
const SHA256_ROUND_CONSTANTS = [
  BigInt(0x428A2F98), BigInt(0x71374491), BigInt(0xB5C0FBCF), BigInt(0xE9B5DBA5),
  BigInt(0x3956C25B), BigInt(0x59F111F1), BigInt(0x923F82A4), BigInt(0xAB1C5ED5),
  BigInt(0xD807AA98), BigInt(0x12835B01), BigInt(0x243185BE), BigInt(0x550C7DC3),
  BigInt(0x72BE5D74), BigInt(0x80DEB1FE), BigInt(0x9BDC06A7), BigInt(0xC19BF174),
  BigInt(0xE49B69C1), BigInt(0xEFBE4786), BigInt(0x0FC19DC6), BigInt(0x240CA1CC),
  BigInt(0x2DE92C6F), BigInt(0x4A7484AA), BigInt(0x5CB0A9DC), BigInt(0x76F988DA),
  BigInt(0x983E5152), BigInt(0xA831C66D), BigInt(0xB00327C8), BigInt(0xBF597FC7),
  BigInt(0xC6E00BF3), BigInt(0xD5A79147), BigInt(0x06CA6351), BigInt(0x14292967),
  BigInt(0x27B70A85), BigInt(0x2E1B2138), BigInt(0x4D2C6DFC), BigInt(0x53380D13),
  BigInt(0x650A7354), BigInt(0x766A0ABB), BigInt(0x81C2C92E), BigInt(0x92722C85),
  BigInt(0xA2BFE8A1), BigInt(0xA81A664B), BigInt(0xC24B8B70), BigInt(0xC76C51A3),
  BigInt(0xD192E819), BigInt(0xD6990624), BigInt(0xF40E3585), BigInt(0x106AA070),
  BigInt(0x19A4C116), BigInt(0x1E376C08), BigInt(0x2748774C), BigInt(0x34B0BCB5),
  BigInt(0x391C0CB3), BigInt(0x4ED8AA4A), BigInt(0x5B9CCA4F), BigInt(0x682E6FF3),
  BigInt(0x748F82EE), BigInt(0x78A5636F), BigInt(0x84C87814), BigInt(0x8CC70208),
  BigInt(0x90BEFFFA), BigInt(0xA4506CEB), BigInt(0xBEF9A3F7), BigInt(0xC67178F2),
];
const SHA256_ADJUSTMENT = BigInt(0xC9DC06A7);
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = BigInt(0x059C0B80);
const SHA256_SIGMA1_ADJUSTMENT = BigInt(0x000B92C0);

const CS64_COEFFICIENTS: ReadonlyArray<readonly [bigint, bigint]> = [
  [BigInt(0xE82E91B1), BigInt(0xB32700D0)], [BigInt(0x44DE24C6), BigInt(0x88DFF51D)],
  [BigInt(0x3BEB65BC), BigInt(0x29514038)], [BigInt(0xC89C5933), BigInt(0xB328CBDF)],
  [BigInt(0x8D1EC211), BigInt(0xD405B4D5)], [BigInt(0x314EF5D5), BigInt(0x26E55F3C)],
  [BigInt(0xE92491B1), BigInt(0x607801C6)], [BigInt(0xF0A5B9D5), BigInt(0x82B2C1FB)],
  [BigInt(0x06064CF3), BigInt(0xFA51A3DA)], [BigInt(0xDA79FA60), BigInt(0x207CC464)],
  [BigInt(0xBED20560), BigInt(0x3C3C74F3)], [BigInt(0x89F9C9F8), BigInt(0xD2D14B61)],
  [BigInt(0x35FA38C6), BigInt(0xBB04A2C1)], [BigInt(0xCB49E3C6), BigInt(0xC5626167)],
];
const CS64_FACTOR = BigInt(0x82893933);
const CS64_ADJUSTMENT0 = BigInt(0xF2F90B1A);
const CS64_ADJUSTMENT1 = BigInt(0x0B1A0000);

const u32 = (value: bigint): bigint => value & MASK;
const rol16 = (value: bigint): bigint => {
  const v = value & MASK;
  return ((v << BigInt(16)) | (v >> BigInt(16))) & MASK;
};
const rotr = (value: bigint, n: number): bigint =>
  ((value >> BigInt(n)) | (value << BigInt(32 - n))) & MASK;

// Masked sigmas, as used by `_sha256_init`.
const sigma0 = (v: bigint) =>
  u32((v >> BigInt(7)) ^ (v << BigInt(25)) ^ (v >> BigInt(18)) ^ (v << BigInt(14)) ^ (v >> BigInt(3)));
const sigma1 = (v: bigint) =>
  u32((v >> BigInt(17)) ^ (v << BigInt(15)) ^ (v >> BigInt(19)) ^ (v << BigInt(13)) ^ (v >> BigInt(10)));

function sha256Rounds(state: bigint[], words: bigint[], firstRound = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i += 1) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & MASK & g);
    const t1 = u32(h + s1 + ch + constants[i] + words[i]);
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = u32(s0 + maj);
    h = g; g = f; f = e; e = u32(d + t1); d = c; c = b; b = a; a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words: bigint[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i += 1) {
    const x = words[i - 2];
    const y = words[i - 15];
    // Raw (unmasked) sigmas; the reference masks only the final sum.
    const sig1 = (x >> BigInt(17)) ^ (x << BigInt(15)) ^ (x >> BigInt(19)) ^ (x << BigInt(13)) ^ (x >> BigInt(10));
    const sig0 = (y >> BigInt(7)) ^ (y << BigInt(25)) ^ (y >> BigInt(18)) ^ (y << BigInt(14)) ^ (y >> BigInt(3));
    words.push(u32(sig1 + words[i - 7] + sig0 + words[i - 16]));
  }
}

function sha256Init(data: Uint8Array): bigint[] {
  const words: bigint[] = new Array(14).fill(BigInt(0));
  words.push(BigInt((data[0] << 16) | (data[1] << 8) | data[2]));
  words.push(BigInt(((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0));
  for (let i = 16; i < 30; i += 1) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      value += i === 16 ? sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT : sigma1(words[i - 2]);
    }
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) {
      value += i === 29 ? sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT : sigma0(words[i - 15]);
    }
    words.push(u32(value));
  }
  words.push(u32(
    sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] +
    SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14],
  ));
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((value, i) => u32(value + working[i]));
}

function sha256Digest(data: Uint8Array): Buffer {
  if (data.length < 7) throw new Error("token salt must contain at least seven bytes");
  const length = 57 + data.length;
  const padded = Buffer.concat([
    Buffer.from(data.subarray(7)),
    Buffer.from([0x80]),
    Buffer.alloc(((55 - length) % 64 + 64) % 64),
  ]);
  const lengthBytes = Buffer.alloc(8);
  lengthBytes.writeBigUInt64BE(BigInt(length * 8));
  const block = Buffer.concat([padded, lengthBytes]);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < block.length; offset += 64) {
    const words: bigint[] = [];
    for (let j = 0; j < 16; j += 1) words.push(BigInt(block.readUInt32BE(offset + j * 4)));
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((value, i) => u32(value + working[i]));
  }
  const out = Buffer.alloc(32);
  state.forEach((value, i) => out.writeUInt32BE(Number(value), i * 4));
  return out;
}

/** Little-endian u32 words of `\x00 + data`, zero-padded to an even count. */
function wordsLe4Even(data: Uint8Array): bigint[] {
  const prefixed = Buffer.concat([Buffer.from([0]), Buffer.from(data)]);
  const padded = Buffer.concat([prefixed, Buffer.alloc((4 - (prefixed.length % 4)) % 4)]);
  const words: bigint[] = [];
  for (let i = 0; i < padded.length; i += 4) words.push(BigInt(padded.readUInt32LE(i)));
  if (words.length % 2) words.push(BigInt(0));
  return words;
}

function cs64Digest(data: Uint8Array, digest: Buffer): [number, number] {
  const keyA = BigInt(digest.readUInt32LE(0)) | BigInt(1);
  const keyB = BigInt(digest.readUInt32LE(4)) | BigInt(1);
  const factors = [u32(keyA * CS64_FACTOR), u32(keyB * CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coefficient], i) => u32(coefficient * factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);

  for (const [index, word] of wordsLe4Even(data).entries()) {
    let term = word * (index % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (index % 2 === 0 ? BigInt(0xEF0569FB) : BigInt(0xC31713DB));
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(u32(term));
    offsets.push(u32(offset));
  }

  let swapAcc = BigInt(0);
  let swapLast = BigInt(0);
  let state = BigInt(0);
  let acc = BigInt(0);
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];
    let t = rol16(u32(offsets[index] + x));
    let q = u32(t * BigInt(0x76F50F34));
    swapAcc += u32(rol16(q) * BigInt(0xC3EFEA97) + q);
    t = rol16(u32(offsets[index + 1] + y));
    q = u32(t * BigInt(0x1881CE3C));
    swapLast = u32(rol16(q) * BigInt(0x35BD1EC9) + q);
    swapAcc = u32(swapAcc + swapLast);

    state = u32(state * keyA + x);
    state = u32(rol16(state) * BigInt(0xCF98B111));
    state = u32(rol16(state) * BigInt(0x87085B9F));
    state = u32(rol16(state) * BigInt(0x12CEB96D));
    state = u32(rol16(state) * BigInt(0x257E1D83));
    acc += state;
    t = u32(state * keyB + y);
    t = u32(rol16(t) * BigInt(0xA27416F5));
    t = u32(rol16(t) * BigInt(0xD38396FF));
    state = u32(rol16(u32(rol16(t) * BigInt(0x7C932B89))) * BigInt(0xBFA49F69));
    acc = u32(acc + state);
  }
  return [Number(swapLast ^ state), Number(swapAcc ^ acc)];
}

/**
 * Generate the v2 Sec-MS-GEC token. `unixTimestampSec` defaults to now and is
 * only overridden by tests.
 */
export function generateSecMsGecV2(unixTimestampSec: number = Date.now() / 1000): string {
  // Windows file time, rounded down to the nearest 5 minutes, in 100ns units.
  let ticks = BigInt(Math.floor(unixTimestampSec)) + WIN_EPOCH;
  ticks -= ticks % BigInt(300);
  ticks *= BigInt(10000000);
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const digest = sha256Digest(data);
  const [cs64A, cs64B] = cs64Digest(data, digest);
  const cs64 = Buffer.alloc(8);
  cs64.writeUInt32LE(cs64A >>> 0, 0);
  cs64.writeUInt32LE(cs64B >>> 0, 4);
  return `${cs64.toString("hex").toUpperCase()}-${digest.toString("hex").toUpperCase()}`;
}
