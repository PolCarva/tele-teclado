// SHA-1, MD5 and HMAC in plain TypeScript (WebSocket handshake, digest auth, TV pairing signatures).

import { utf8Encode } from '../protocol/bytes';
import { sha256 } from '../protocol/sha256';

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

export function sha1(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = data.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const w = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = t;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = data.length * 8;
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 0x100000000), true);
  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(block + i * 4, true);
    let a = a0,
      b = b0,
      c = c0,
      d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i])) >>> 0;
      a = t;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => outView.setUint32(i * 4, v, true));
  return out;
}

export function hmac(hash: (data: Uint8Array) => Uint8Array, blockSize: number, key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key.length > blockSize ? hash(key) : key;
  const padded = new Uint8Array(blockSize);
  padded.set(k);
  k = padded;
  const inner = new Uint8Array(blockSize + message.length);
  const outer = new Uint8Array(blockSize + hash(new Uint8Array(0)).length);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(message, blockSize);
  outer.set(hash(inner), blockSize);
  return hash(outer);
}

export const hmacSha1 = (key: Uint8Array, message: Uint8Array) => hmac(sha1, 64, key, message);
export const hmacSha256 = (key: Uint8Array, message: Uint8Array) => hmac(sha256, 64, key, message);

export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export const md5Hex = (text: string) => hexOf(md5(utf8Encode(text)));
