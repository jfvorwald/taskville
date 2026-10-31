// SHA-256 (FIPS 180-4) and a strict UTF-8 encoder, written in plain ECMAScript.
//
// Why a pure, synchronous implementation instead of Web Crypto:
// - Web Crypto's crypto.subtle.digest is async. Reducers, selectors and every
//   stateHash caller are synchronous pure functions, and forcing them async would
//   ripple through the whole domain for no gain.
// - The code uses no host API at all (no TextEncoder, no crypto, no Buffer), so it
//   gives byte-identical results in Node, any browser, and a bare V8 context.
// - Inputs are small (one event's fields, one project's state), so speed is not
//   the constraint; tests compare against node:crypto and Web Crypto.
// This is for content addressing and determinism checks, not for secrets: it is
// not constant-time.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** SHA-256 digest of `data`, as 32 bytes. */
export function sha256(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bitLength = data.length * 8;
  // Message, a 0x80 byte, zero padding, then the 64-bit big-endian bit length,
  // rounded up to whole 64-byte blocks.
  const total = Math.ceil((data.length + 9) / 64) * 64;
  const block = new Uint8Array(total);
  block.set(data);
  block[data.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(total - 4, bitLength >>> 0);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] as number;
      const y = w[t - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] as number);
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * UTF-8 bytes of `text`. Throws a TypeError on a lone surrogate rather than
 * replacing it with U+FFFD the way TextEncoder does, because replacement would
 * let two different strings hash the same.
 */
export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  // At most 3 bytes per UTF-16 code unit (a surrogate pair is 2 units, 4 bytes).
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (cp > 0xdbff || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`lone surrogate at index ${i} cannot be encoded as UTF-8`);
      }
      cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
      i++;
    }
    if (cp < 0x80) {
      out[n++] = cp;
    } else if (cp < 0x800) {
      out[n++] = 0xc0 | (cp >> 6);
      out[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[n++] = 0xe0 | (cp >> 12);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    } else {
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 0x3f);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return out.slice(0, n);
}

/** SHA-256 as 64 lowercase hex characters. A string is hashed as its UTF-8 bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const digest = sha256(typeof input === "string" ? utf8Encode(input) : input);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
