// AES-128 (block cipher) and CBC mode without padding, in plain TypeScript.
// Panasonic VIERA (2019+) wraps every command in AES-128-CBC + HMAC-SHA256.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const MUL2 = new Uint8Array(256);

(function init() {
  // Build the S-box from the multiplicative inverse in GF(2^8) plus the affine transform.
  let p = 1,
    q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    INV_SBOX[SBOX[i]] = i;
    MUL2[i] = ((i << 1) ^ (i & 0x80 ? 0x1b : 0)) & 0xff;
  }
})();

function mul(a: number, b: number): number {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = MUL2[a];
    b >>= 1;
  }
  return r;
}

/** Expands a 16-byte key into 11 round keys (176 bytes). */
export function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error('AES-128 needs a 16-byte key');
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4],
      t1 = w[i - 3],
      t2 = w[i - 2],
      t3 = w[i - 1];
    if (i % 16 === 0) {
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = MUL2[rcon];
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function encryptBlock(rk: Uint8Array, input: Uint8Array): Uint8Array {
  const s = input.slice(0, 16);
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    // ShiftRows (state is column-major: s[col*4 + row])
    let t = s[1];
    s[1] = s[5];
    s[5] = s[9];
    s[9] = s[13];
    s[13] = t;
    t = s[2];
    s[2] = s[10];
    s[10] = t;
    t = s[6];
    s[6] = s[14];
    s[14] = t;
    t = s[15];
    s[15] = s[11];
    s[11] = s[7];
    s[7] = s[3];
    s[3] = t;
    if (round < 10) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c],
          a1 = s[c + 1],
          a2 = s[c + 2],
          a3 = s[c + 3];
        s[c] = MUL2[a0] ^ MUL2[a1] ^ a1 ^ a2 ^ a3;
        s[c + 1] = a0 ^ MUL2[a1] ^ MUL2[a2] ^ a2 ^ a3;
        s[c + 2] = a0 ^ a1 ^ MUL2[a2] ^ MUL2[a3] ^ a3;
        s[c + 3] = MUL2[a0] ^ a0 ^ a1 ^ a2 ^ MUL2[a3];
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
  }
  return s;
}

function decryptBlock(rk: Uint8Array, input: Uint8Array): Uint8Array {
  const s = input.slice(0, 16);
  for (let i = 0; i < 16; i++) s[i] ^= rk[160 + i];
  for (let round = 9; round >= 0; round--) {
    // InvShiftRows
    let t = s[13];
    s[13] = s[9];
    s[9] = s[5];
    s[5] = s[1];
    s[1] = t;
    t = s[2];
    s[2] = s[10];
    s[10] = t;
    t = s[6];
    s[6] = s[14];
    s[14] = t;
    t = s[3];
    s[3] = s[7];
    s[7] = s[11];
    s[11] = s[15];
    s[15] = t;
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
    if (round > 0) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c],
          a1 = s[c + 1],
          a2 = s[c + 2],
          a3 = s[c + 3];
        s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    }
  }
  return s;
}

/** AES-128-CBC encryption; `data` must be a multiple of 16 bytes (the caller pads). */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('AES-CBC data must be a multiple of 16 bytes');
  const rk = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = iv.slice(0, 16);
  for (let i = 0; i < data.length; i += 16) {
    const block = data.slice(i, i + 16);
    for (let j = 0; j < 16; j++) block[j] ^= prev[j];
    prev = encryptBlock(rk, block);
    out.set(prev, i);
  }
  return out;
}

/** AES-128-CBC decryption (no padding removed). */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('AES-CBC data must be a multiple of 16 bytes');
  const rk = expandKey(key);
  const out = new Uint8Array(data.length);
  let prev: Uint8Array = iv.slice(0, 16);
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    const plain = decryptBlock(rk, block);
    for (let j = 0; j < 16; j++) out[i + j] = plain[j] ^ prev[j];
    prev = block.slice();
  }
  return out;
}
