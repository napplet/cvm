// ../../../cache/npm/registry.npmjs.org/@noble/hashes/2.0.1/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new Error(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed) throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished) throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i2 = 0; i2 < arrays.length; i2++) {
    arrays[i2].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({
  length: 256
}, (_, i2) => i2.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin) return bytes.toHex();
  let hex = "";
  for (let i2 = 0; i2 < bytes.length; i2++) {
    hex += hexes[bytes[i2]];
  }
  return hex;
}
var asciis = {
  _0: 48,
  _9: 57,
  A: 65,
  F: 70,
  a: 97,
  f: 102
};
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9) return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F) return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f) return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string") throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin) return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2) throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i2 = 0; i2 < arrays.length; i2++) {
    const a = arrays[i2];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i2 = 0, pad = 0; i2 < arrays.length; i2++) {
    const a = arrays[i2];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function") throw new Error("crypto.getRandomValues must be defined");
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([
    6,
    9,
    96,
    134,
    72,
    1,
    101,
    3,
    4,
    2,
    suffix
  ])
});

// ../../../cache/npm/registry.npmjs.org/@noble/hashes/2.0.1/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen) this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i2 = pos; i2 < blockLen; i2++) buffer[i2] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4) throw new Error("_sha2: outputLen must be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length) throw new Error("_sha2: outputLen bigger than state");
    for (let i2 = 0; i2 < outLen; i2++) oview.setUint32(4 * i2, state[i2], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to ||= new this.constructor();
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen) to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../../../cache/npm/registry.npmjs.org/@noble/hashes/2.0.1/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen) {
    super(64, outputLen, 8, false);
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H
    ];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i2 = 0; i2 < 16; i2++, offset += 4) SHA256_W[i2] = view.getUint32(offset, false);
    for (let i2 = 16; i2 < 64; i2++) {
      const W15 = SHA256_W[i2 - 15];
      const W2 = SHA256_W[i2 - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i2] = s1 + SHA256_W[i2 - 7] + s0 + SHA256_W[i2 - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i2 = 0; i2 < 64; i2++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i2] + SHA256_W[i2] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  A = SHA256_IV[0] | 0;
  B = SHA256_IV[1] | 0;
  C = SHA256_IV[2] | 0;
  D = SHA256_IV[3] | 0;
  E = SHA256_IV[4] | 0;
  F = SHA256_IV[5] | 0;
  G = SHA256_IV[6] | 0;
  H = SHA256_IV[7] | 0;
  constructor() {
    super(32);
  }
};
var sha256 = /* @__PURE__ */ createHasher(() => new _SHA256(), /* @__PURE__ */ oidNist(1));

// ../../../cache/npm/registry.npmjs.org/@noble/curves/2.0.1/utils.js
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function abool(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}" `;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n)) throw new Error("positive bigint expected, got " + n);
  } else anumber(n);
  return n;
}
function hexToNumber(hex) {
  if (typeof hex !== "string") throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  n = abignumber(n);
  const res = hexToBytes(n.toString(16).padStart(len * 2, "0"));
  if (res.length !== len) throw new Error("number too large");
  return res;
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}
function asciiToBytes(ascii) {
  return Uint8Array.from(ascii, (c, i2) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new Error(`string contains non-ASCII character "${ascii[i2]}" with code ${charCode} at position ${i2}`);
    }
    return charCode;
  });
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1) ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function validateObject(object, fields = {}, optFields = {}) {
  if (!object || typeof object !== "object") throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === void 0) return;
    const current = typeof val;
    if (current !== expectedType || val === null) throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, false);
  iter(optFields, true);
}
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0) return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// ../../../cache/npm/registry.npmjs.org/@noble/curves/2.0.1/abstract/modular.js
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2) throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2) throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd2 = b;
  if (gcd2 !== _1n2) throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  if (!Fp.eql(Fp.sqr(root), n)) throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
  const p1div4 = (Fp.ORDER + _1n2) / _4n;
  const root = Fp.pow(n, p1div4);
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt5mod8(Fp, n) {
  const p5div8 = (Fp.ORDER - _5n) / _8n;
  const n2 = Fp.mul(n, _2n);
  const v = Fp.pow(n2, p5div8);
  const nv = Fp.mul(n, v);
  const i2 = Fp.mul(Fp.mul(nv, _2n), v);
  const root = Fp.mul(nv, Fp.sub(i2, Fp.ONE));
  assertIsSquare(Fp, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    let tv1 = Fp.pow(n, c4);
    let tv2 = Fp.mul(tv1, c1);
    const tv3 = Fp.mul(tv1, c2);
    const tv4 = Fp.mul(tv1, c3);
    const e1 = Fp.eql(Fp.sqr(tv2), n);
    const e2 = Fp.eql(Fp.sqr(tv3), n);
    tv1 = Fp.cmov(tv1, tv2, e1);
    tv2 = Fp.cmov(tv4, tv3, e2);
    const e3 = Fp.eql(Fp.sqr(tv2), n);
    const root = Fp.cmov(tv1, tv2, e3);
    assertIsSquare(Fp, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n) throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3) throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1) return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp, n) {
    if (Fp.is0(n)) return n;
    if (FpLegendre(Fp, n) !== 1) throw new Error("Cannot find square root");
    let M2 = S;
    let c = Fp.mul(Fp.ONE, cc);
    let t = Fp.pow(n, Q);
    let R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t)) return Fp.ZERO;
      let i2 = 1;
      let t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE)) {
        i2++;
        t_tmp = Fp.sqr(t_tmp);
        if (i2 === M2) throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M2 - i2 - 1);
      const b = Fp.pow(c, exponent);
      M2 = i2;
      c = Fp.sqr(b);
      t = Fp.mul(t, c);
      R = Fp.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n) return sqrt3mod4;
  if (P % _8n === _5n) return sqrt5mod8;
  if (P % _16n === _9n) return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  validateObject(field, opts);
  return field;
}
function FpPow(Fp, num2, power) {
  if (power < _0n2) throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2) return Fp.ONE;
  if (power === _1n2) return num2;
  let p = Fp.ONE;
  let d = num2;
  while (power > _0n2) {
    if (power & _1n2) p = Fp.mul(p, d);
    d = Fp.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num2, i2) => {
    if (Fp.is0(num2)) return acc;
    inverted[i2] = acc;
    return Fp.mul(acc, num2);
  }, Fp.ONE);
  const invertedAcc = Fp.inv(multipliedAcc);
  nums.reduceRight((acc, num2, i2) => {
    if (Fp.is0(num2)) return acc;
    inverted[i2] = Fp.mul(acc, inverted[i2]);
    return Fp.mul(acc, num2);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp, n) {
  const p1mod2 = (Fp.ORDER - _1n2) / _2n;
  const powered = Fp.pow(n, p1mod2);
  const yes = Fp.eql(powered, Fp.ONE);
  const zero = Fp.eql(powered, Fp.ZERO);
  const no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no) throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0) anumber(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return {
    nBitLength: _nBitLength,
    nByteLength
  };
}
var _Field = class {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _sqrt;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _0n2) throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
    let _nbitLength = void 0;
    this.isLE = false;
    if (opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number") _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function") this.sqrt = opts.sqrt;
      if (typeof opts.isLE === "boolean") this.isLE = opts.isLE;
      if (opts.allowedLengths) this._lengths = opts.allowedLengths?.slice();
      if (typeof opts.modFromBytes === "boolean") this._mod = opts.modFromBytes;
    }
    const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048) throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER;
    this.BITS = nBitLength;
    this.BYTES = nByteLength;
    this._sqrt = void 0;
    Object.preventExtensions(this);
  }
  create(num2) {
    return mod(num2, this.ORDER);
  }
  isValid(num2) {
    if (typeof num2 !== "bigint") throw new Error("invalid field element: expected bigint, got " + typeof num2);
    return _0n2 <= num2 && num2 < this.ORDER;
  }
  is0(num2) {
    return num2 === _0n2;
  }
  // is valid and invertible
  isValidNot0(num2) {
    return !this.is0(num2) && this.isValid(num2);
  }
  isOdd(num2) {
    return (num2 & _1n2) === _1n2;
  }
  neg(num2) {
    return mod(-num2, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num2) {
    return mod(num2 * num2, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num2, power) {
    return FpPow(this, num2, power);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  // Same as above, but doesn't normalize
  sqrN(num2) {
    return num2 * num2;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num2) {
    return invert(num2, this.ORDER);
  }
  sqrt(num2) {
    if (!this._sqrt) this._sqrt = FpSqrt(this.ORDER);
    return this._sqrt(this, num2);
  }
  toBytes(num2) {
    return this.isLE ? numberToBytesLE(num2, this.BYTES) : numberToBytesBE(num2, this.BYTES);
  }
  fromBytes(bytes, skipValidation = false) {
    abytes(bytes);
    const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
        throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      }
      const padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
      bytes = padded;
    }
    if (bytes.length !== BYTES) throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes) scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar)) throw new Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  // TODO: we don't need it here, move out to separate fn
  invertBatch(lst) {
    return FpInvertBatch(this, lst);
  }
  // We can't move this out because Fp6, Fp12 implement it
  // and it's unclear what to return in there.
  cmov(a, b, condition) {
    return condition ? b : a;
  }
};
function Field(ORDER, opts = {}) {
  return new _Field(ORDER, opts);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint") throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = false) {
  abytes(key);
  const len = key.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024) throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num2 = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
  const reduced = mod(num2, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// ../../../cache/npm/registry.npmjs.org/@noble/curves/2.0.1/abstract/curve.js
var _0n3 = /* @__PURE__ */ BigInt(0);
var _1n3 = /* @__PURE__ */ BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i2) => c.fromAffine(p.toAffine(invertedZs[i2])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits) throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return {
    windows,
    windowSize,
    mask,
    maxNumber,
    shiftBy
  };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return {
    nextN,
    offset,
    isZero,
    isNeg,
    isNegF,
    offsetF
  };
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3) throw new Error("invalid wNAF");
}
var wNAF = class {
  BASE;
  ZERO;
  Fn;
  bits;
  // Parametrized with a given Point class (not individual point)
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  // non-const time multiplication ladder
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3) p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param point Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base = p;
    for (let window = 0; window < windows; window++) {
      base = p;
      points.push(base);
      for (let i2 = 1; i2 < windowSize; i2++) {
        base = base.add(p);
        points.push(base);
      }
      p = base.double();
    }
    return points;
  }
  /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * More compact implementation:
     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
     * @returns real and fake (for const-time) points
     */
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n)) throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return {
      p,
      f
    };
  }
  /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window = 0; window < wo.windows; window++) {
      if (n === _0n3) break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function") comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1) return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
};
function mulEndoUnsafe(Point, point, k1, k2) {
  let acc = point;
  let p1 = Point.ZERO;
  let p2 = Point.ZERO;
  while (k1 > _0n3 || k2 > _0n3) {
    if (k1 & _1n3) p1 = p1.add(acc);
    if (k2 & _1n3) p2 = p2.add(acc);
    acc = acc.double();
    k1 >>= _1n3;
    k2 >>= _1n3;
  }
  return {
    p1,
    p2
  };
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order) throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, {
      isLE
    });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0) FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object") throw new Error(`expected valid ${type} CURVE object`);
  for (const p of [
    "p",
    "n",
    "h"
  ]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3)) throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = [
    "Gx",
    "Gy",
    "a",
    _b
  ];
  for (const p of params) {
    if (!Fp.isValid(CURVE[p])) throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return {
    CURVE,
    Fp,
    Fn
  };
}
function createKeygen(randomSecretKey, getPublicKey2) {
  return function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return {
      secretKey,
      publicKey: getPublicKey2(secretKey)
    };
  };
}

// ../../../cache/npm/registry.npmjs.org/@noble/curves/2.0.1/abstract/weierstrass.js
var divNearest = (num2, den) => (num2 + (num2 >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  const [[a1, b1], [a2, b2]] = basis;
  const c1 = divNearest(b2 * k, n);
  const c2 = divNearest(-b1 * k, n);
  let k1 = k - c1 * a1 - c2 * a2;
  let k2 = -c1 * b1 - c2 * b2;
  const k1neg = k1 < _0n4;
  const k2neg = k2 < _0n4;
  if (k1neg) k1 = -k1;
  if (k2neg) k2 = -k2;
  const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {
    throw new Error("splitScalar (endomorphism): failed, k=" + k);
  }
  return {
    k1neg,
    k1,
    k2neg,
    k2
  };
}
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function weierstrass(params, extraOpts = {}) {
  const validated = createCurveFields("weierstrass", params, extraOpts);
  const { Fp, Fn } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor, n: CURVE_ORDER } = CURVE;
  validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object"
  });
  const { endo } = extraOpts;
  if (endo) {
    if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
      throw new Error('invalid endo: expected "beta": bigint and "basises": array');
    }
  }
  const lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd) throw new Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes2(_c, point, isCompressed) {
    const { x, y } = point.toAffine();
    const bx = Fp.toBytes(x);
    abool(isCompressed, "isCompressed");
    if (isCompressed) {
      assertCompressionIsSupported();
      const hasEvenY = !Fp.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else {
      return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
    }
  }
  function pointFromBytes(bytes) {
    abytes(bytes, void 0, "Point");
    const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
    const length = bytes.length;
    const head = bytes[0];
    const tail = bytes.subarray(1);
    if (length === comp && (head === 2 || head === 3)) {
      const x = Fp.fromBytes(tail);
      if (!Fp.isValid(x)) throw new Error("bad point: is not on curve, wrong x");
      const y2 = weierstrassEquation(x);
      let y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw new Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      const evenY = Fp.isOdd(y);
      const evenH = (head & 1) === 1;
      if (evenH !== evenY) y = Fp.neg(y);
      return {
        x,
        y
      };
    } else if (length === uncomp && head === 4) {
      const L = Fp.BYTES;
      const x = Fp.fromBytes(tail.subarray(0, L));
      const y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y)) throw new Error("bad point: is not on curve");
      return {
        x,
        y
      };
    } else {
      throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
    }
  }
  const encodePoint = extraOpts.toBytes || pointToBytes2;
  const decodePoint = extraOpts.fromBytes || pointFromBytes;
  function weierstrassEquation(x) {
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy)) throw new Error("bad curve params: generator point");
  const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
  const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2))) throw new Error("bad curve params: a or b");
  function acoord(title, n, banZero = false) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n)) throw new Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point)) throw new Error("Weierstrass Point expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises) throw new Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    if (Fp.eql(Z, Fp.ONE)) return {
      x: X,
      y: Y
    };
    const is0 = p.is0();
    if (iz == null) iz = is0 ? Fp.ONE : Fp.inv(Z);
    const x = Fp.mul(X, iz);
    const y = Fp.mul(Y, iz);
    const zz = Fp.mul(Z, iz);
    if (is0) return {
      x: Fp.ZERO,
      y: Fp.ZERO
    };
    if (!Fp.eql(zz, Fp.ONE)) throw new Error("invZ was invalid");
    return {
      x,
      y
    };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y)) return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y)) throw new Error("bad point: x or y not field elements");
    if (!isValidXY(x, y)) throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree()) throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
    k1p = negateCt(k1neg, k1p);
    k2p = negateCt(k2neg, k2p);
    return k1p.add(k2p);
  }
  class Point {
    // base / generator point
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    // zero / infinity / identity point
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    // math field
    static Fp = Fp;
    // scalar field
    static Fn = Fn;
    X;
    Y;
    Z;
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    constructor(X, Y, Z) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y, true);
      this.Z = acoord("z", Z);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y)) throw new Error("invalid affine point");
      if (p instanceof Point) throw new Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y)) return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes) {
      const P = Point.fromAffine(decodePoint(abytes(bytes, void 0, "point")));
      P.assertValidity();
      return P;
    }
    static fromHex(hex) {
      return Point.fromBytes(hexToBytes(hex));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
         *
         * @param windowSize
         * @param isLazy true will defer table computation until the first multiplication
         * @returns
         */
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy) this.multiply(_3n2);
      return this;
    }
    // TODO: return `this`
    /** A point on curve is valid if it conforms to equation. */
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (!Fp.isOdd) throw new Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    /** Compare one point to another. */
    equals(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      aprjpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    /**
         * Constant time multiplication.
         * Uses wNAF method. Windowed method may be 10% faster,
         * but takes 2x longer to generate and consumes 2x memory.
         * Uses precomputes when available.
         * Uses endomorphism for Koblitz curves.
         * @param scalar by which the point would be multiplied
         * @returns New point
         */
    multiply(scalar) {
      const { endo: endo2 } = extraOpts;
      if (!Fn.isValidNot0(scalar)) throw new Error("invalid scalar: out of range");
      let point, fake;
      const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
        const { p: k1p, f: k1f } = mul(k1);
        const { p: k2p, f: k2f } = mul(k2);
        fake = k1f.add(k2f);
        point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
      } else {
        const { p, f } = mul(scalar);
        point = p;
        fake = f;
      }
      return normalizeZ(Point, [
        point,
        fake
      ])[0];
    }
    /**
         * Non-constant-time multiplication. Uses double-and-add algorithm.
         * It's faster, but should only be used when you don't care about
         * an exposed secret key e.g. sig verification, which works over *public* keys.
         */
    multiplyUnsafe(sc) {
      const { endo: endo2 } = extraOpts;
      const p = this;
      if (!Fn.isValid(sc)) throw new Error("invalid scalar: out of range");
      if (sc === _0n4 || p.is0()) return Point.ZERO;
      if (sc === _1n4) return p;
      if (wnaf.hasCache(this)) return this.multiply(sc);
      if (endo2) {
        const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
        const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
        return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
      } else {
        return wnaf.unsafe(p, sc);
      }
    }
    /**
         * Converts Projective point to affine (x, y) coordinates.
         * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
         */
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    /**
         * Checks whether Point is free of torsion elements (is in prime subgroup).
         * Always torsion-free for cofactor=1 curves.
         */
    isTorsionFree() {
      const { isTorsionFree } = extraOpts;
      if (cofactor === _1n4) return true;
      if (isTorsionFree) return isTorsionFree(Point, this);
      return wnaf.unsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      const { clearCofactor } = extraOpts;
      if (cofactor === _1n4) return this;
      if (clearCofactor) return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    toBytes(isCompressed = true) {
      abool(isCompressed, "isCompressed");
      this.assertValidity();
      return encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = true) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const bits = Fn.BITS;
  const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
  Point.BASE.precompute(8);
  return Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: true,
    signature: 2 * Fn.BYTES
  };
}

// ../../../cache/npm/registry.npmjs.org/@noble/curves/2.0.1/secp256k1.js
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
var secp256k1_ENDO = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [
      BigInt("0x3086d221a7d46bcde86c90e49284eb15"),
      -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")
    ],
    [
      BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"),
      BigInt("0x3086d221a7d46bcde86c90e49284eb15")
    ]
  ]
};
var _0n5 = /* @__PURE__ */ BigInt(0);
var _2n3 = /* @__PURE__ */ BigInt(2);
function sqrtMod(y) {
  const P = secp256k1_CURVE.p;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n3, P) * b3 % P;
  const b9 = pow2(b6, _3n3, P) * b3 % P;
  const b11 = pow2(b9, _2n3, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n3, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y)) throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = Field(secp256k1_CURVE.p, {
  sqrt: sqrtMod
});
var Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
  Fp: Fpk1,
  endo: secp256k1_ENDO
});
var TAGGED_HASH_PREFIXES = {};
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === void 0) {
    const tagH = sha256(asciiToBytes(tag));
    tagP = concatBytes(tagH, tagH);
    TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes(tagP, ...messages));
}
var pointToBytes = (point) => point.toBytes(true).slice(1);
var hasEven = (y) => y % _2n3 === _0n5;
function schnorrGetExtPubKey(priv) {
  const { Fn, BASE } = Pointk1;
  const d_ = Fn.fromBytes(priv);
  const p = BASE.multiply(d_);
  const scalar = hasEven(p.y) ? d_ : Fn.neg(d_);
  return {
    scalar,
    bytes: pointToBytes(p)
  };
}
function lift_x(x) {
  const Fp = Fpk1;
  if (!Fp.isValidNot0(x)) throw new Error("invalid x: Fail if x \u2265 p");
  const xx = Fp.create(x * x);
  const c = Fp.create(xx * x + BigInt(7));
  let y = Fp.sqrt(c);
  if (!hasEven(y)) y = Fp.neg(y);
  const p = Pointk1.fromAffine({
    x,
    y
  });
  p.assertValidity();
  return p;
}
var num = bytesToNumberBE;
function challenge(...args) {
  return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(secretKey) {
  return schnorrGetExtPubKey(secretKey).bytes;
}
function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {
  const { Fn } = Pointk1;
  const m = abytes(message, void 0, "message");
  const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);
  const a = abytes(auxRand, 32, "auxRand");
  const t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a)));
  const rand = taggedHash("BIP0340/nonce", t, px, m);
  const { bytes: rx, scalar: k } = schnorrGetExtPubKey(rand);
  const e = challenge(rx, px, m);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);
  if (!schnorrVerify(sig, m, px)) throw new Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  const { Fp, Fn, BASE } = Pointk1;
  const sig = abytes(signature, 64, "signature");
  const m = abytes(message, void 0, "message");
  const pub = abytes(publicKey, 32, "publicKey");
  try {
    const P = lift_x(num(pub));
    const r = num(sig.subarray(0, 32));
    if (!Fp.isValidNot0(r)) return false;
    const s = num(sig.subarray(32, 64));
    if (!Fn.isValidNot0(s)) return false;
    const e = challenge(Fn.toBytes(r), pointToBytes(P), m);
    const R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));
    const { x, y } = R.toAffine();
    if (R.is0() || !hasEven(y) || x !== r) return false;
    return true;
  } catch (error) {
    return false;
  }
}
var schnorr = /* @__PURE__ */ (() => {
  const size = 32;
  const seedLength = 48;
  const randomSecretKey = (seed = randomBytes(seedLength)) => {
    return mapHashToField(seed, secp256k1_CURVE.n);
  };
  return {
    keygen: createKeygen(randomSecretKey, schnorrGetPublicKey),
    getPublicKey: schnorrGetPublicKey,
    sign: schnorrSign,
    verify: schnorrVerify,
    Point: Pointk1,
    utils: {
      randomSecretKey,
      taggedHash,
      lift_x,
      pointToBytes
    },
    lengths: {
      secretKey: size,
      publicKey: size,
      publicKeyHasPrefix: false,
      signature: size * 2,
      seed: seedLength
    }
  };
})();

// ../../../cache/npm/registry.npmjs.org/nostr-tools/2.24.1/lib/esm/pool.js
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder();
function normalizeURL(url) {
  try {
    if (url.indexOf("://") === -1) url = "wss://" + url;
    let p = new URL(url);
    if (p.protocol === "http:") p.protocol = "ws:";
    else if (p.protocol === "https:") p.protocol = "wss:";
    p.pathname = p.pathname.replace(/\/+/g, "/");
    if (p.pathname.endsWith("/")) p.pathname = p.pathname.slice(0, -1);
    if (p.port === "80" && p.protocol === "ws:" || p.port === "443" && p.protocol === "wss:") p.port = "";
    p.searchParams.sort();
    p.hash = "";
    return p.toString();
  } catch (e) {
    throw new Error(`Invalid URL: ${url}`);
  }
}
function isHex32(input) {
  for (let i2 = 0; i2 < 64; i2++) {
    let cc = input.charCodeAt(i2);
    if (isNaN(cc) || cc < 48 || cc > 102 || cc > 57 && cc < 97) {
      return false;
    }
  }
  return true;
}
var verifiedSymbol = Symbol("verified");
var isRecord = (obj) => obj instanceof Object;
function validateEvent(event) {
  if (!isRecord(event)) return false;
  if (typeof event.kind !== "number") return false;
  if (typeof event.content !== "string") return false;
  if (typeof event.created_at !== "number") return false;
  if (typeof event.pubkey !== "string") return false;
  if (!isHex32(event.pubkey)) return false;
  if (!Array.isArray(event.tags)) return false;
  for (let i2 = 0; i2 < event.tags.length; i2++) {
    let tag = event.tags[i2];
    if (!Array.isArray(tag)) return false;
    for (let j = 0; j < tag.length; j++) {
      if (typeof tag[j] !== "string") return false;
    }
  }
  return true;
}
var JS = class {
  generateSecretKey() {
    return schnorr.utils.randomSecretKey();
  }
  getPublicKey(secretKey) {
    return bytesToHex(schnorr.getPublicKey(secretKey));
  }
  finalizeEvent(t, secretKey) {
    const event = t;
    event.pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
    event.id = getEventHash(event);
    event.sig = bytesToHex(schnorr.sign(hexToBytes(getEventHash(event)), secretKey));
    event[verifiedSymbol] = true;
    return event;
  }
  verifyEvent(event) {
    if (typeof event[verifiedSymbol] === "boolean") return event[verifiedSymbol];
    try {
      const hash = getEventHash(event);
      if (hash !== event.id) {
        event[verifiedSymbol] = false;
        return false;
      }
      const valid = schnorr.verify(hexToBytes(event.sig), hexToBytes(hash), hexToBytes(event.pubkey));
      event[verifiedSymbol] = valid;
      return valid;
    } catch (err) {
      event[verifiedSymbol] = false;
      return false;
    }
  }
};
function serializeEvent(evt) {
  if (!validateEvent(evt)) throw new Error("can't serialize event with wrong or missing properties");
  return JSON.stringify([
    0,
    evt.pubkey,
    evt.created_at,
    evt.kind,
    evt.tags,
    evt.content
  ]);
}
function getEventHash(event) {
  let eventHash = sha256(utf8Encoder.encode(serializeEvent(event)));
  return bytesToHex(eventHash);
}
var i = new JS();
var generateSecretKey = i.generateSecretKey;
var getPublicKey = i.getPublicKey;
var finalizeEvent = i.finalizeEvent;
var verifyEvent = i.verifyEvent;
var ClientAuth = 22242;
function matchFilter(filter, event) {
  if (filter.ids && filter.ids.indexOf(event.id) === -1) {
    return false;
  }
  if (filter.kinds && filter.kinds.indexOf(event.kind) === -1) {
    return false;
  }
  if (filter.authors && filter.authors.indexOf(event.pubkey) === -1) {
    return false;
  }
  for (let f in filter) {
    if (f[0] === "#") {
      let tagName = f.slice(1);
      let values = filter[`#${tagName}`];
      if (values && !event.tags.find(([t, v]) => t === f.slice(1) && values.indexOf(v) !== -1)) return false;
    }
  }
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;
  return true;
}
function matchFilters(filters, event) {
  for (let i2 = 0; i2 < filters.length; i2++) {
    if (matchFilter(filters[i2], event)) {
      return true;
    }
  }
  return false;
}
function getHex64(json, field) {
  let len = field.length + 3;
  let idx = json.indexOf(`"${field}":`) + len;
  let s = json.slice(idx).indexOf(`"`) + idx + 1;
  return json.slice(s, s + 64);
}
function getSubscriptionId(json) {
  let idx = json.slice(0, 22).indexOf(`"EVENT"`);
  if (idx === -1) return null;
  let pstart = json.slice(idx + 7 + 1).indexOf(`"`);
  if (pstart === -1) return null;
  let start = idx + 7 + 1 + pstart;
  let pend = json.slice(start + 1, 80).indexOf(`"`);
  if (pend === -1) return null;
  let end = start + 1 + pend;
  return json.slice(start + 1, end);
}
function makeAuthEvent(relayURL, challenge2) {
  return {
    kind: ClientAuth,
    created_at: Math.floor(Date.now() / 1e3),
    tags: [
      [
        "relay",
        relayURL
      ],
      [
        "challenge",
        challenge2
      ]
    ],
    content: ""
  };
}
var SendingOnClosedConnection = class extends Error {
  constructor(message, relay) {
    super(`Tried to send message '${message} on a closed connection to ${relay}.`);
    this.name = "SendingOnClosedConnection";
  }
};
var AbstractRelay = class {
  url;
  _connected = false;
  onclose = null;
  onnotice = (msg) => console.debug(`NOTICE from ${this.url}: ${msg}`);
  onauth;
  baseEoseTimeout = 4400;
  publishTimeout = 4400;
  pingFrequency = 29e3;
  pingTimeout = 2e4;
  resubscribeBackoff = [
    1e4,
    1e4,
    1e4,
    2e4,
    2e4,
    3e4,
    6e4
  ];
  openSubs = /* @__PURE__ */ new Map();
  enablePing;
  enableReconnect;
  idleTimeout = 0;
  idleSince = Date.now();
  ongoingOperations = 0;
  reconnectTimeoutHandle;
  pingIntervalHandle;
  reconnectAttempts = 0;
  skipReconnection = false;
  idleTimeoutHandle;
  connectionPromise;
  openCountRequests = /* @__PURE__ */ new Map();
  openEventPublishes = /* @__PURE__ */ new Map();
  ws;
  challenge;
  authPromise;
  serial = 0;
  verifyEvent;
  _WebSocket;
  constructor(url, opts) {
    this.url = normalizeURL(url);
    this.verifyEvent = opts.verifyEvent;
    this._WebSocket = opts.websocketImplementation || WebSocket;
    this.enablePing = opts.enablePing;
    this.enableReconnect = opts.enableReconnect || false;
    if (opts.idleTimeout) this.idleTimeout = opts.idleTimeout;
  }
  static async connect(url, opts) {
    const relay = new AbstractRelay(url, opts);
    await relay.connect(opts);
    return relay;
  }
  closeAllSubscriptions(reason) {
    for (let [_, sub] of this.openSubs) {
      sub.close(reason);
    }
    this.openSubs.clear();
    for (let [_, ep] of this.openEventPublishes) {
      ep.reject(new Error(reason));
    }
    this.openEventPublishes.clear();
    for (let [_, cr] of this.openCountRequests) {
      cr.reject(new Error(reason));
    }
    this.openCountRequests.clear();
  }
  get connected() {
    return this._connected;
  }
  clearIdleTimeout() {
    if (this.idleTimeoutHandle) {
      clearTimeout(this.idleTimeoutHandle);
      this.idleTimeoutHandle = void 0;
    }
  }
  scheduleIdleClose() {
    this.clearIdleTimeout();
    if (this.idleTimeout > 0) {
      this.idleTimeoutHandle = setTimeout(() => {
        if (this.ongoingOperations === 0 && this.idleSince) {
          this.close();
        }
      }, this.idleTimeout);
    }
  }
  async reconnect() {
    const backoff = this.resubscribeBackoff[Math.min(this.reconnectAttempts, this.resubscribeBackoff.length - 1)];
    this.reconnectAttempts++;
    this.reconnectTimeoutHandle = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
      }
    }, backoff);
  }
  handleHardClose(reason) {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
    }
    if (this.pingIntervalHandle) {
      clearInterval(this.pingIntervalHandle);
      this.pingIntervalHandle = void 0;
    }
    this._connected = false;
    this.connectionPromise = void 0;
    this.idleSince = void 0;
    this.clearIdleTimeout();
    if (this.enableReconnect && !this.skipReconnection) {
      this.reconnect();
    } else {
      this.onclose?.();
      this.closeAllSubscriptions(reason);
    }
  }
  async connect(opts) {
    let connectionTimeoutHandle;
    if (this.connectionPromise) return this.connectionPromise;
    this.challenge = void 0;
    this.authPromise = void 0;
    this.skipReconnection = false;
    this.connectionPromise = new Promise((resolve3, reject) => {
      if (opts?.timeout) {
        connectionTimeoutHandle = setTimeout(() => {
          reject("connection timed out");
          this.connectionPromise = void 0;
          if (this.reconnectAttempts === 0) {
            this.skipReconnection = true;
          }
          this.handleHardClose("relay connection timed out");
        }, opts.timeout);
      }
      if (opts?.abort) {
        opts.abort.onabort = reject;
      }
      try {
        this.ws = new this._WebSocket(this.url);
      } catch (err) {
        clearTimeout(connectionTimeoutHandle);
        reject(err);
        return;
      }
      this.ws.onopen = () => {
        if (this.reconnectTimeoutHandle) {
          clearTimeout(this.reconnectTimeoutHandle);
          this.reconnectTimeoutHandle = void 0;
        }
        clearTimeout(connectionTimeoutHandle);
        this._connected = true;
        const isReconnection = this.reconnectAttempts > 0;
        this.reconnectAttempts = 0;
        for (const sub of this.openSubs.values()) {
          sub.eosed = false;
          if (isReconnection) {
            for (let f = 0; f < sub.filters.length; f++) {
              if (sub.lastEmitted) {
                sub.filters[f].since = sub.lastEmitted + 1;
              }
            }
          }
          sub.fire();
        }
        if (this.enablePing) {
          this.pingIntervalHandle = setInterval(() => this.pingpong(), this.pingFrequency);
        }
        resolve3();
      };
      this.ws.onerror = () => {
        clearTimeout(connectionTimeoutHandle);
        reject("connection failed");
        this.connectionPromise = void 0;
        if (this.reconnectAttempts === 0) {
          this.skipReconnection = true;
        }
        this.handleHardClose("relay connection failed");
      };
      this.ws.onclose = (ev) => {
        clearTimeout(connectionTimeoutHandle);
        reject(ev.message || "websocket closed");
        this.handleHardClose("relay connection closed");
      };
      this.ws.onmessage = this._onmessage.bind(this);
    });
    return this.connectionPromise;
  }
  waitForPingPong() {
    return new Promise((resolve3) => {
      ;
      this.ws.once("pong", () => resolve3(true));
      this.ws.ping();
    });
  }
  waitForDummyReq() {
    return new Promise((resolve3, reject) => {
      if (!this.connectionPromise) return reject(new Error(`no connection to ${this.url}, can't ping`));
      try {
        const sub = this.subscribe([
          {
            ids: [
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            ],
            limit: 0
          }
        ], {
          label: "<forced-ping>",
          oneose: () => {
            resolve3(true);
            sub.close();
          },
          onclose() {
            resolve3(true);
          },
          eoseTimeout: this.pingTimeout + 1e3
        });
      } catch (err) {
        reject(err);
      }
    });
  }
  async pingpong() {
    if (this.ws?.readyState === 1) {
      const result = await Promise.any([
        this.ws && this.ws.ping && this.ws.once ? this.waitForPingPong() : this.waitForDummyReq(),
        new Promise((res) => setTimeout(() => res(false), this.pingTimeout))
      ]);
      if (!result) {
        if (this.ws?.readyState === this._WebSocket.OPEN) {
          this.ws?.close();
        }
      }
    }
  }
  async send(message) {
    if (!this.connectionPromise) throw new SendingOnClosedConnection(message, this.url);
    this.connectionPromise.then(() => {
      this.ws?.send(message);
    });
  }
  async auth(signAuthEvent) {
    const challenge2 = this.challenge;
    if (!challenge2) throw new Error("can't perform auth, no challenge was received");
    if (this.authPromise) return this.authPromise;
    this.authPromise = new Promise(async (resolve3, reject) => {
      try {
        let evt = await signAuthEvent(makeAuthEvent(this.url, challenge2));
        let timeout = setTimeout(() => {
          let ep = this.openEventPublishes.get(evt.id);
          if (ep) {
            ep.reject(new Error("auth timed out"));
            this.openEventPublishes.delete(evt.id);
          }
        }, this.publishTimeout);
        this.openEventPublishes.set(evt.id, {
          resolve: resolve3,
          reject,
          timeout
        });
        this.send('["AUTH",' + JSON.stringify(evt) + "]");
      } catch (err) {
        console.warn("subscribe auth function failed:", err);
      }
    });
    return this.authPromise;
  }
  async publish(event) {
    this.idleSince = void 0;
    this.clearIdleTimeout();
    this.ongoingOperations++;
    const ret = new Promise((resolve3, reject) => {
      const timeout = setTimeout(() => {
        const ep = this.openEventPublishes.get(event.id);
        if (ep) {
          ep.reject(new Error("publish timed out"));
          this.openEventPublishes.delete(event.id);
        }
      }, this.publishTimeout);
      this.openEventPublishes.set(event.id, {
        resolve: resolve3,
        reject,
        timeout
      });
    });
    try {
      await this.send('["EVENT",' + JSON.stringify(event) + "]");
    } catch (err) {
      const ep = this.openEventPublishes.get(event.id);
      if (ep) {
        ep.reject(err);
        this.openEventPublishes.delete(event.id);
      }
    }
    this.ongoingOperations--;
    if (this.ongoingOperations === 0) {
      this.idleSince = Date.now();
      this.scheduleIdleClose();
    }
    return ret;
  }
  async count(filters, params) {
    return (await this.countWithHLL(filters, params)).count;
  }
  async countWithHLL(filters, params) {
    this.serial++;
    const id = params?.id || "count:" + this.serial;
    const ret = new Promise((resolve3, reject) => {
      this.openCountRequests.set(id, {
        resolve: resolve3,
        reject
      });
    });
    try {
      await this.send('["COUNT","' + id + '",' + JSON.stringify(filters).substring(1));
    } catch (err) {
      const cr = this.openCountRequests.get(id);
      if (cr) {
        cr.reject(err);
        this.openCountRequests.delete(id);
      }
    }
    return ret;
  }
  subscribe(filters, params) {
    if (params.label !== "<forced-ping>") {
      this.idleSince = void 0;
      this.clearIdleTimeout();
      this.ongoingOperations++;
    }
    const sub = this.prepareSubscription(filters, params);
    sub.fire();
    if (params.abort) {
      params.abort.onabort = () => sub.close(String(params.abort.reason || "<aborted>"));
    }
    return sub;
  }
  prepareSubscription(filters, params) {
    this.serial++;
    const id = params.id || (params.label ? params.label + ":" : "sub:") + this.serial;
    const sub = new Subscription(this, id, filters, params);
    this.openSubs.set(id, sub);
    return sub;
  }
  close() {
    this.skipReconnection = true;
    if (this.reconnectTimeoutHandle) {
      clearTimeout(this.reconnectTimeoutHandle);
      this.reconnectTimeoutHandle = void 0;
    }
    if (this.pingIntervalHandle) {
      clearInterval(this.pingIntervalHandle);
      this.pingIntervalHandle = void 0;
    }
    this.closeAllSubscriptions("relay connection closed by us");
    this._connected = false;
    this.connectionPromise = void 0;
    this.idleSince = void 0;
    this.clearIdleTimeout();
    this.onclose?.();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState !== this._WebSocket.CLOSING && this.ws.readyState !== this._WebSocket.CLOSED) {
        this.ws.close();
      }
    }
  }
  _onmessage(ev) {
    const json = ev.data;
    if (!json) {
      return;
    }
    const subid = getSubscriptionId(json);
    if (subid) {
      const so = this.openSubs.get(subid);
      if (!so) {
        return;
      }
      const id = getHex64(json, "id");
      const alreadyHave = so.alreadyHaveEvent?.(id);
      so.receivedEvent?.(this, id);
      if (alreadyHave) {
        return;
      }
    }
    try {
      let data = JSON.parse(json);
      switch (data[0]) {
        case "EVENT": {
          const so = this.openSubs.get(data[1]);
          const event = data[2];
          if (matchFilters(so.filters, event) && this.verifyEvent(event, this.url)) {
            so.onevent(event);
          } else {
            so.oninvalidevent?.(event);
          }
          if (!so.lastEmitted || so.lastEmitted < event.created_at) so.lastEmitted = event.created_at;
          return;
        }
        case "COUNT": {
          const id = data[1];
          const payload = data[2];
          const cr = this.openCountRequests.get(id);
          if (cr) {
            cr.resolve(payload);
            this.openCountRequests.delete(id);
          }
          return;
        }
        case "EOSE": {
          const so = this.openSubs.get(data[1]);
          if (!so) return;
          so.receivedEose();
          return;
        }
        case "OK": {
          const id = data[1];
          const ok = data[2];
          const reason = data[3];
          const ep = this.openEventPublishes.get(id);
          if (ep) {
            clearTimeout(ep.timeout);
            if (ok) ep.resolve(reason);
            else ep.reject(new Error(reason));
            this.openEventPublishes.delete(id);
          }
          return;
        }
        case "CLOSED": {
          const id = data[1];
          const so = this.openSubs.get(id);
          if (!so) {
            const cr = this.openCountRequests.get(id);
            if (cr) {
              cr.reject(new Error(data[2]));
              this.openCountRequests.delete(id);
            }
            return;
          }
          so.closed = true;
          so.close(data[2]);
          return;
        }
        case "NOTICE": {
          this.onnotice(data[1]);
          return;
        }
        case "AUTH": {
          this.challenge = data[1];
          if (this.onauth) {
            this.auth(this.onauth).catch((err) => {
              if (!(err instanceof SendingOnClosedConnection)) {
                throw err;
              }
            });
          }
          return;
        }
        default: {
          const so = this.openSubs.get(data[1]);
          so?.oncustom?.(data);
          return;
        }
      }
    } catch (err) {
      try {
        const [_, __, event] = JSON.parse(json);
        console.warn(`[nostr] relay ${this.url} error processing message:`, err, event);
      } catch (_) {
        console.warn(`[nostr] relay ${this.url} error processing message:`, err);
      }
      return;
    }
  }
};
var Subscription = class {
  relay;
  id;
  lastEmitted;
  closed = false;
  eosed = false;
  filters;
  alreadyHaveEvent;
  receivedEvent;
  onevent;
  oninvalidevent;
  oneose;
  onclose;
  oncustom;
  eoseTimeout;
  eoseTimeoutHandle;
  constructor(relay, id, filters, params) {
    if (filters.length === 0) throw new Error("subscription can't be created with zero filters");
    this.relay = relay;
    this.filters = filters;
    this.id = id;
    this.alreadyHaveEvent = params.alreadyHaveEvent;
    this.receivedEvent = params.receivedEvent;
    this.eoseTimeout = params.eoseTimeout || relay.baseEoseTimeout;
    this.oneose = params.oneose;
    this.onclose = params.onclose;
    this.oninvalidevent = params.oninvalidevent;
    this.onevent = params.onevent || ((event) => {
      console.warn(`onevent() callback not defined for subscription '${this.id}' in relay ${this.relay.url}. event received:`, event);
    });
  }
  fire() {
    this.relay.send('["REQ","' + this.id + '",' + JSON.stringify(this.filters).substring(1));
    this.eoseTimeoutHandle = setTimeout(this.receivedEose.bind(this), this.eoseTimeout);
  }
  receivedEose() {
    if (this.eosed) return;
    clearTimeout(this.eoseTimeoutHandle);
    this.eosed = true;
    this.oneose?.();
  }
  close(reason = "closed by caller") {
    if (!this.closed && this.relay.connected) {
      try {
        this.relay.send('["CLOSE",' + JSON.stringify(this.id) + "]");
      } catch (err) {
        if (err instanceof SendingOnClosedConnection) {
        } else {
          throw err;
        }
      }
      this.closed = true;
    }
    this.relay.openSubs.delete(this.id);
    this.relay.ongoingOperations--;
    if (this.relay.ongoingOperations === 0) {
      this.relay.idleSince = Date.now();
      this.relay.scheduleIdleClose();
    }
    this.onclose?.(reason);
  }
};
var M = 256;
var HLL_HEX_LENGTH = M * 2;
var utf8Encoder2 = new TextEncoder();
function getCountManyFilter(target, directive) {
  switch (directive) {
    case "reactions":
      return {
        "#e": [
          target
        ],
        kinds: [
          7
        ]
      };
    case "reposts":
      return {
        "#e": [
          target
        ],
        kinds: [
          6
        ]
      };
    case "quotes":
      return {
        "#q": [
          target
        ],
        kinds: [
          1,
          1111
        ]
      };
    case "replies":
      return {
        "#e": [
          target
        ],
        kinds: [
          1
        ]
      };
    case "comments":
      return {
        "#E": [
          target
        ],
        kinds: [
          1111
        ]
      };
    case "followers":
      return {
        "#p": [
          target
        ],
        kinds: [
          3
        ]
      };
  }
}
function newHll() {
  return new Uint8Array(M);
}
function hllDecode(hex) {
  if (hex.length !== HLL_HEX_LENGTH || !/^[0-9a-f]+$/.test(hex)) return void 0;
  const registers = new Uint8Array(M);
  for (let i2 = 0; i2 < M; i2++) {
    registers[i2] = parseInt(hex.slice(i2 * 2, i2 * 2 + 2), 16);
  }
  return registers;
}
function hllEncode(registers) {
  if (registers.length !== M) throw new Error(`invalid number of registers ${registers.length}`);
  let hex = "";
  for (let i2 = 0; i2 < M; i2++) {
    hex += registers[i2].toString(16).padStart(2, "0");
  }
  return hex;
}
function mergeHll(target, source) {
  if (target.length === 0) target = newHll();
  if (target.length !== M) throw new Error(`invalid number of registers ${target.length}`);
  if (source.length !== M) throw new Error(`invalid number of registers ${source.length}`);
  for (let i2 = 0; i2 < M; i2++) {
    if (source[i2] > target[i2]) target[i2] = source[i2];
  }
  return target;
}
var AbstractSimplePool = class {
  relays = /* @__PURE__ */ new Map();
  seenOn = /* @__PURE__ */ new Map();
  trackRelays = false;
  verifyEvent;
  enablePing;
  enableReconnect;
  idleTimeout = 2e4;
  automaticallyAuth;
  onRelayConnectionFailure;
  onRelayConnectionSuccess;
  allowConnectingToRelay;
  maxWaitForConnection;
  _WebSocket;
  constructor(opts) {
    this.verifyEvent = opts.verifyEvent;
    this._WebSocket = opts.websocketImplementation;
    this.enablePing = opts.enablePing;
    this.enableReconnect = opts.enableReconnect || false;
    if (opts.idleTimeout) this.idleTimeout = opts.idleTimeout;
    this.automaticallyAuth = opts.automaticallyAuth;
    this.onRelayConnectionFailure = opts.onRelayConnectionFailure;
    this.onRelayConnectionSuccess = opts.onRelayConnectionSuccess;
    this.allowConnectingToRelay = opts.allowConnectingToRelay;
    this.maxWaitForConnection = opts.maxWaitForConnection || 3e3;
  }
  async ensureRelay(url, params) {
    url = normalizeURL(url);
    let relay = this.relays.get(url);
    if (!relay) {
      relay = new AbstractRelay(url, {
        verifyEvent: this.verifyEvent,
        websocketImplementation: this._WebSocket,
        enablePing: this.enablePing,
        enableReconnect: this.enableReconnect,
        idleTimeout: this.idleTimeout
      });
      relay.onclose = () => {
        this.relays.delete(url);
      };
      this.relays.set(url, relay);
    }
    if (this.automaticallyAuth) {
      const authSignerFn = this.automaticallyAuth(url);
      if (authSignerFn) {
        relay.onauth = authSignerFn;
      }
    }
    try {
      await relay.connect({
        timeout: params?.connectionTimeout,
        abort: params?.abort
      });
    } catch (err) {
      this.relays.delete(url);
      throw err;
    }
    return relay;
  }
  close(relays) {
    relays.map(normalizeURL).forEach((url) => {
      this.relays.get(url)?.close();
      this.relays.delete(url);
    });
  }
  subscribe(relays, filter, params) {
    const request = [];
    const uniqUrls = [];
    for (let i2 = 0; i2 < relays.length; i2++) {
      const url = normalizeURL(relays[i2]);
      if (!request.find((r) => r.url === url)) {
        if (uniqUrls.indexOf(url) === -1) {
          uniqUrls.push(url);
          request.push({
            url,
            filter
          });
        }
      }
    }
    return this.subscribeMap(request, params);
  }
  subscribeMany(relays, filter, params) {
    return this.subscribe(relays, filter, params);
  }
  subscribeMap(requests, params) {
    const grouped = /* @__PURE__ */ new Map();
    for (const req of requests) {
      const { url, filter } = req;
      if (!grouped.has(url)) grouped.set(url, []);
      grouped.get(url).push(filter);
    }
    const groupedRequests = Array.from(grouped.entries()).map(([url, filters]) => ({
      url,
      filters
    }));
    if (this.trackRelays) {
      params.receivedEvent = (relay, id) => {
        let set = this.seenOn.get(id);
        if (!set) {
          set = /* @__PURE__ */ new Set();
          this.seenOn.set(id, set);
        }
        set.add(relay);
      };
    }
    const _knownIds = /* @__PURE__ */ new Set();
    const subs = [];
    const eosesReceived = [];
    let handleEose = (i2) => {
      if (eosesReceived[i2]) return;
      eosesReceived[i2] = true;
      if (eosesReceived.filter((a) => a).length === groupedRequests.length) {
        params.oneose?.();
        handleEose = () => {
        };
      }
    };
    const closesReceived = [];
    let handleClose = (i2, url, reason) => {
      if (closesReceived[i2]) return;
      handleEose(i2);
      closesReceived[i2] = {
        url,
        reason
      };
      if (closesReceived.filter((a) => a).length === groupedRequests.length) {
        params.onclose?.(closesReceived);
        handleClose = () => {
        };
      }
    };
    const localAlreadyHaveEventHandler = (id) => {
      if (params.alreadyHaveEvent?.(id)) {
        return true;
      }
      const have = _knownIds.has(id);
      _knownIds.add(id);
      return have;
    };
    const allOpened = Promise.all(groupedRequests.map(async ({ url, filters }, i2) => {
      if (this.allowConnectingToRelay?.(url, [
        "read",
        filters
      ]) === false) {
        handleClose(i2, url, "connection skipped by allowConnectingToRelay");
        return;
      }
      let relay;
      try {
        relay = await this.ensureRelay(url, {
          connectionTimeout: this.maxWaitForConnection < (params.maxWait || 0) ? Math.max(params.maxWait * 0.8, params.maxWait - 1e3) : this.maxWaitForConnection,
          abort: params.abort
        });
      } catch (err) {
        this.onRelayConnectionFailure?.(url);
        handleClose(i2, url, err?.message || String(err));
        return;
      }
      this.onRelayConnectionSuccess?.(url);
      let subscription = relay.subscribe(filters, {
        ...params,
        oneose: () => handleEose(i2),
        onclose: (reason) => {
          if (reason.startsWith("auth-required: ") && params.onauth) {
            relay.auth(params.onauth).then(() => {
              relay.subscribe(filters, {
                ...params,
                oneose: () => handleEose(i2),
                onclose: (reason2) => {
                  handleClose(i2, url, reason2);
                },
                alreadyHaveEvent: localAlreadyHaveEventHandler,
                eoseTimeout: params.maxWait,
                abort: params.abort
              });
            }).catch((err) => {
              handleClose(i2, url, `auth was required and attempted, but failed with: ${err}`);
            });
          } else {
            handleClose(i2, url, reason);
          }
        },
        alreadyHaveEvent: localAlreadyHaveEventHandler,
        eoseTimeout: params.maxWait,
        abort: params.abort
      });
      subs.push(subscription);
    }));
    return {
      async close(reason) {
        await allOpened;
        subs.forEach((sub) => {
          sub.close(reason);
        });
      }
    };
  }
  subscribeEose(relays, filter, params) {
    let subcloser;
    subcloser = this.subscribe(relays, filter, {
      ...params,
      oneose() {
        const reason = "closed automatically on eose";
        if (subcloser) subcloser.close(reason);
        else params.onclose?.(relays.map((url) => ({
          url,
          reason
        })));
      }
    });
    return subcloser;
  }
  subscribeManyEose(relays, filter, params) {
    return this.subscribeEose(relays, filter, params);
  }
  async querySync(relays, filter, params) {
    return new Promise(async (resolve3) => {
      const events = [];
      this.subscribeEose(relays, filter, {
        ...params,
        onevent(event) {
          events.push(event);
        },
        onclose(_) {
          resolve3(events);
        }
      });
    });
  }
  async get(relays, filter, params) {
    filter.limit = 1;
    const events = await this.querySync(relays, filter, params);
    events.sort((a, b) => b.created_at - a.created_at);
    return events[0] || null;
  }
  async countMany(relays, target, directive, params) {
    const filter = getCountManyFilter(target, directive);
    const urls = [];
    for (let i2 = 0; i2 < relays.length; i2++) {
      const url = normalizeURL(relays[i2]);
      if (urls.indexOf(url) === -1) urls.push(url);
    }
    const responses = await Promise.all(urls.map(async (url) => {
      if (this.allowConnectingToRelay?.(url, [
        "read",
        [
          filter
        ]
      ]) === false) return null;
      let relay;
      try {
        relay = await this.ensureRelay(url, {
          connectionTimeout: this.maxWaitForConnection < (params?.maxWait || 0) ? Math.max(params.maxWait * 0.8, params.maxWait - 1e3) : this.maxWaitForConnection,
          abort: params?.abort
        });
      } catch (err) {
        this.onRelayConnectionFailure?.(url);
        return null;
      }
      this.onRelayConnectionSuccess?.(url);
      return relay.countWithHLL([
        filter
      ], {
        id: params?.id
      }).catch(() => null);
    }));
    let count = 0;
    let hll;
    for (const response of responses) {
      if (!response) continue;
      if (response.count > count) count = response.count;
      if (!response.hll || response.hll.length !== 512) continue;
      const registers = hllDecode(response.hll);
      if (!registers) continue;
      hll = mergeHll(hll || new Uint8Array(0), registers);
    }
    return hll ? {
      count,
      hll: hllEncode(hll)
    } : {
      count
    };
  }
  publish(relays, event, params) {
    return relays.map(normalizeURL).map(async (url, i2, arr) => {
      if (arr.indexOf(url) !== i2) {
        return Promise.reject("duplicate url");
      }
      if (this.allowConnectingToRelay?.(url, [
        "write",
        event
      ]) === false) {
        return Promise.reject("connection skipped by allowConnectingToRelay");
      }
      let r;
      try {
        r = await this.ensureRelay(url, {
          connectionTimeout: this.maxWaitForConnection < (params?.maxWait || 0) ? Math.max(params.maxWait * 0.8, params.maxWait - 1e3) : this.maxWaitForConnection,
          abort: params?.abort
        });
      } catch (err) {
        this.onRelayConnectionFailure?.(url);
        return String("connection failure: " + String(err));
      }
      return r.publish(event).catch(async (err) => {
        if (err instanceof Error && err.message.startsWith("auth-required: ") && params?.onauth) {
          await r.auth(params.onauth);
          return r.publish(event);
        }
        throw err;
      }).then((reason) => {
        if (this.trackRelays) {
          let set = this.seenOn.get(event.id);
          if (!set) {
            set = /* @__PURE__ */ new Set();
            this.seenOn.set(event.id, set);
          }
          set.add(r);
        }
        return reason;
      });
    });
  }
  listConnectionStatus() {
    const map = /* @__PURE__ */ new Map();
    this.relays.forEach((relay, url) => map.set(url, relay.connected));
    return map;
  }
  destroy() {
    this.relays.forEach((conn) => conn.close());
    this.relays = /* @__PURE__ */ new Map();
  }
  pruneIdleRelays(idleThresholdMs = 1e4) {
    const prunedUrls = [];
    for (const [url, relay] of this.relays) {
      if (relay.idleSince && Date.now() - relay.idleSince >= idleThresholdMs) {
        this.relays.delete(url);
        prunedUrls.push(url);
        relay.close();
      }
    }
    return prunedUrls;
  }
};
var _WebSocket;
try {
  _WebSocket = WebSocket;
} catch {
}
var SimplePool = class extends AbstractSimplePool {
  constructor(options) {
    super({
      verifyEvent,
      websocketImplementation: _WebSocket,
      maxWaitForConnection: 3e3,
      ...options
    });
  }
};

// ../../../cache/npm/registry.npmjs.org/@scure/base/1.2.6/lib/esm/index.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function isArrayOf(isString, arr) {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0) return true;
  if (isString) {
    return arr.every((item) => typeof item === "string");
  } else {
    return arr.every((item) => Number.isSafeInteger(item));
  }
}
function astr(label, input) {
  if (typeof input !== "string") throw new Error(`${label}: string expected`);
  return true;
}
function anumber2(n) {
  if (!Number.isSafeInteger(n)) throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
  if (!Array.isArray(input)) throw new Error("array expected");
}
function astrArr(label, input) {
  if (!isArrayOf(true, input)) throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
  if (!isArrayOf(false, input)) throw new Error(`${label}: array of numbers expected`);
}
// @__NO_SIDE_EFFECTS__
function chain(...args) {
  const id = (a) => a;
  const wrap = (a, b) => (c) => a(b(c));
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  const decode = args.map((x) => x.decode).reduce(wrap, id);
  return {
    encode,
    decode
  };
}
// @__NO_SIDE_EFFECTS__
function alphabet(letters) {
  const lettersA = typeof letters === "string" ? letters.split("") : letters;
  const len = lettersA.length;
  astrArr("alphabet", lettersA);
  const indexes = new Map(lettersA.map((l, i2) => [
    l,
    i2
  ]));
  return {
    encode: (digits) => {
      aArr(digits);
      return digits.map((i2) => {
        if (!Number.isSafeInteger(i2) || i2 < 0 || i2 >= len) throw new Error(`alphabet.encode: digit index outside alphabet "${i2}". Allowed: ${letters}`);
        return lettersA[i2];
      });
    },
    decode: (input) => {
      aArr(input);
      return input.map((letter) => {
        astr("alphabet.decode", letter);
        const i2 = indexes.get(letter);
        if (i2 === void 0) throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i2;
      });
    }
  };
}
// @__NO_SIDE_EFFECTS__
function join(separator = "") {
  astr("join", separator);
  return {
    encode: (from) => {
      astrArr("join.decode", from);
      return from.join(separator);
    },
    decode: (to) => {
      astr("join.decode", to);
      return to.split(separator);
    }
  };
}
var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
var radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
var powers = /* @__PURE__ */ (() => {
  let res = [];
  for (let i2 = 0; i2 < 40; i2++) res.push(2 ** i2);
  return res;
})();
function convertRadix2(data, from, to, padding) {
  aArr(data);
  if (from <= 0 || from > 32) throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32) throw new Error(`convertRadix2: wrong to=${to}`);
  if (/* @__PURE__ */ radix2carry(from, to) > 32) {
    throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
  }
  let carry = 0;
  let pos = 0;
  const max = powers[from];
  const mask = powers[to] - 1;
  const res = [];
  for (const n of data) {
    anumber2(n);
    if (n >= max) throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = carry << from | n;
    if (pos + from > 32) throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (; pos >= to; pos -= to) res.push((carry >> pos - to & mask) >>> 0);
    const pow = powers[pos];
    if (pow === void 0) throw new Error("invalid carry");
    carry &= pow - 1;
  }
  carry = carry << to - pos & mask;
  if (!padding && pos >= from) throw new Error("Excess padding");
  if (!padding && carry > 0) throw new Error(`Non-zero padding: ${carry}`);
  if (padding && pos > 0) res.push(carry >>> 0);
  return res;
}
// @__NO_SIDE_EFFECTS__
function radix2(bits, revPadding = false) {
  anumber2(bits);
  if (bits <= 0 || bits > 32) throw new Error("radix2: bits should be in (0..32]");
  if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32) throw new Error("radix2: carry overflow");
  return {
    encode: (bytes) => {
      if (!isBytes2(bytes)) throw new Error("radix2.encode input should be Uint8Array");
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits) => {
      anumArr("radix2.decode", digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    }
  };
}
var base64urlnopad = /* @__PURE__ */ chain(/* @__PURE__ */ radix2(6), /* @__PURE__ */ alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), /* @__PURE__ */ join(""));

// deno:https://jsr.io/@std/media-types/1.1.0/_util.ts
var CHAR_CODE_SPACE = " ".charCodeAt(0);
var CHAR_CODE_TILDE = "~".charCodeAt(0);

// deno:https://jsr.io/@std/media-types/1.1.0/vendor/db.ts
var db_default = {
  "application/1d-interleaved-parityfec": {
    "source": "iana"
  },
  "application/3gpdash-qoe-report+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/3gpp-ims+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/3gpphal+json": {
    "source": "iana",
    "compressible": true
  },
  "application/3gpphalforms+json": {
    "source": "iana",
    "compressible": true
  },
  "application/a2l": {
    "source": "iana"
  },
  "application/ace+cbor": {
    "source": "iana"
  },
  "application/ace+json": {
    "source": "iana",
    "compressible": true
  },
  "application/ace-groupcomm+cbor": {
    "source": "iana"
  },
  "application/activemessage": {
    "source": "iana"
  },
  "application/activity+json": {
    "source": "iana",
    "compressible": true
  },
  "application/aif+cbor": {
    "source": "iana"
  },
  "application/aif+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-cdni+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-cdnifilter+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-costmap+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-costmapfilter+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-directory+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-endpointcost+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-endpointcostparams+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-endpointprop+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-endpointpropparams+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-error+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-networkmap+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-networkmapfilter+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-propmap+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-propmapparams+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-tips+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-tipsparams+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-updatestreamcontrol+json": {
    "source": "iana",
    "compressible": true
  },
  "application/alto-updatestreamparams+json": {
    "source": "iana",
    "compressible": true
  },
  "application/aml": {
    "source": "iana"
  },
  "application/andrew-inset": {
    "source": "iana",
    "extensions": [
      "ez"
    ]
  },
  "application/appinstaller": {
    "compressible": false,
    "extensions": [
      "appinstaller"
    ]
  },
  "application/applefile": {
    "source": "iana"
  },
  "application/applixware": {
    "source": "apache",
    "extensions": [
      "aw"
    ]
  },
  "application/appx": {
    "compressible": false,
    "extensions": [
      "appx"
    ]
  },
  "application/appxbundle": {
    "compressible": false,
    "extensions": [
      "appxbundle"
    ]
  },
  "application/at+jwt": {
    "source": "iana"
  },
  "application/atf": {
    "source": "iana"
  },
  "application/atfx": {
    "source": "iana"
  },
  "application/atom+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "atom"
    ]
  },
  "application/atomcat+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "atomcat"
    ]
  },
  "application/atomdeleted+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "atomdeleted"
    ]
  },
  "application/atomicmail": {
    "source": "iana"
  },
  "application/atomsvc+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "atomsvc"
    ]
  },
  "application/atsc-dwd+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "dwd"
    ]
  },
  "application/atsc-dynamic-event-message": {
    "source": "iana"
  },
  "application/atsc-held+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "held"
    ]
  },
  "application/atsc-rdt+json": {
    "source": "iana",
    "compressible": true
  },
  "application/atsc-rsat+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rsat"
    ]
  },
  "application/atxml": {
    "source": "iana"
  },
  "application/auth-policy+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/automationml-aml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "aml"
    ]
  },
  "application/automationml-amlx+zip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "amlx"
    ]
  },
  "application/bacnet-xdd+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/batch-smtp": {
    "source": "iana"
  },
  "application/bdoc": {
    "compressible": false,
    "extensions": [
      "bdoc"
    ]
  },
  "application/beep+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/bufr": {
    "source": "iana"
  },
  "application/c2pa": {
    "source": "iana"
  },
  "application/calendar+json": {
    "source": "iana",
    "compressible": true
  },
  "application/calendar+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xcs"
    ]
  },
  "application/call-completion": {
    "source": "iana"
  },
  "application/cals-1840": {
    "source": "iana"
  },
  "application/captive+json": {
    "source": "iana",
    "compressible": true
  },
  "application/cbor": {
    "source": "iana"
  },
  "application/cbor-seq": {
    "source": "iana"
  },
  "application/cccex": {
    "source": "iana"
  },
  "application/ccmp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/ccxml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ccxml"
    ]
  },
  "application/cda+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/cdfx+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "cdfx"
    ]
  },
  "application/cdmi-capability": {
    "source": "iana",
    "extensions": [
      "cdmia"
    ]
  },
  "application/cdmi-container": {
    "source": "iana",
    "extensions": [
      "cdmic"
    ]
  },
  "application/cdmi-domain": {
    "source": "iana",
    "extensions": [
      "cdmid"
    ]
  },
  "application/cdmi-object": {
    "source": "iana",
    "extensions": [
      "cdmio"
    ]
  },
  "application/cdmi-queue": {
    "source": "iana",
    "extensions": [
      "cdmiq"
    ]
  },
  "application/cdni": {
    "source": "iana"
  },
  "application/cea": {
    "source": "iana"
  },
  "application/cea-2018+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/cellml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/cfw": {
    "source": "iana"
  },
  "application/cid-edhoc+cbor-seq": {
    "source": "iana"
  },
  "application/city+json": {
    "source": "iana",
    "compressible": true
  },
  "application/clr": {
    "source": "iana"
  },
  "application/clue+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/clue_info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/cms": {
    "source": "iana"
  },
  "application/cnrp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/coap-group+json": {
    "source": "iana",
    "compressible": true
  },
  "application/coap-payload": {
    "source": "iana"
  },
  "application/commonground": {
    "source": "iana"
  },
  "application/concise-problem-details+cbor": {
    "source": "iana"
  },
  "application/conference-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/cose": {
    "source": "iana"
  },
  "application/cose-key": {
    "source": "iana"
  },
  "application/cose-key-set": {
    "source": "iana"
  },
  "application/cose-x509": {
    "source": "iana"
  },
  "application/cpl+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "cpl"
    ]
  },
  "application/csrattrs": {
    "source": "iana"
  },
  "application/csta+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/cstadata+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/csvm+json": {
    "source": "iana",
    "compressible": true
  },
  "application/cu-seeme": {
    "source": "apache",
    "extensions": [
      "cu"
    ]
  },
  "application/cwl": {
    "source": "iana",
    "extensions": [
      "cwl"
    ]
  },
  "application/cwl+json": {
    "source": "iana",
    "compressible": true
  },
  "application/cwl+yaml": {
    "source": "iana"
  },
  "application/cwt": {
    "source": "iana"
  },
  "application/cybercash": {
    "source": "iana"
  },
  "application/dart": {
    "compressible": true
  },
  "application/dash+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mpd"
    ]
  },
  "application/dash-patch+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mpp"
    ]
  },
  "application/dashdelta": {
    "source": "iana"
  },
  "application/davmount+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "davmount"
    ]
  },
  "application/dca-rft": {
    "source": "iana"
  },
  "application/dcd": {
    "source": "iana"
  },
  "application/dec-dx": {
    "source": "iana"
  },
  "application/dialog-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/dicom": {
    "source": "iana"
  },
  "application/dicom+json": {
    "source": "iana",
    "compressible": true
  },
  "application/dicom+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/dii": {
    "source": "iana"
  },
  "application/dit": {
    "source": "iana"
  },
  "application/dns": {
    "source": "iana"
  },
  "application/dns+json": {
    "source": "iana",
    "compressible": true
  },
  "application/dns-message": {
    "source": "iana"
  },
  "application/docbook+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "dbk"
    ]
  },
  "application/dots+cbor": {
    "source": "iana"
  },
  "application/dpop+jwt": {
    "source": "iana"
  },
  "application/dskpp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/dssc+der": {
    "source": "iana",
    "extensions": [
      "dssc"
    ]
  },
  "application/dssc+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xdssc"
    ]
  },
  "application/dvcs": {
    "source": "iana"
  },
  "application/ecmascript": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "ecma"
    ]
  },
  "application/edhoc+cbor-seq": {
    "source": "iana"
  },
  "application/edi-consent": {
    "source": "iana"
  },
  "application/edi-x12": {
    "source": "iana",
    "compressible": false
  },
  "application/edifact": {
    "source": "iana",
    "compressible": false
  },
  "application/efi": {
    "source": "iana"
  },
  "application/elm+json": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/elm+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.cap+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/emergencycalldata.comment+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.control+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.deviceinfo+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.ecall.msd": {
    "source": "iana"
  },
  "application/emergencycalldata.legacyesn+json": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.providerinfo+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.serviceinfo+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.subscriberinfo+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emergencycalldata.veds+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/emma+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "emma"
    ]
  },
  "application/emotionml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "emotionml"
    ]
  },
  "application/encaprtp": {
    "source": "iana"
  },
  "application/epp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/epub+zip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "epub"
    ]
  },
  "application/eshop": {
    "source": "iana"
  },
  "application/exi": {
    "source": "iana",
    "extensions": [
      "exi"
    ]
  },
  "application/expect-ct-report+json": {
    "source": "iana",
    "compressible": true
  },
  "application/express": {
    "source": "iana",
    "extensions": [
      "exp"
    ]
  },
  "application/fastinfoset": {
    "source": "iana"
  },
  "application/fastsoap": {
    "source": "iana"
  },
  "application/fdf": {
    "source": "iana",
    "extensions": [
      "fdf"
    ]
  },
  "application/fdt+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "fdt"
    ]
  },
  "application/fhir+json": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/fhir+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/fido.trusted-apps+json": {
    "compressible": true
  },
  "application/fits": {
    "source": "iana"
  },
  "application/flexfec": {
    "source": "iana"
  },
  "application/font-sfnt": {
    "source": "iana"
  },
  "application/font-tdpfr": {
    "source": "iana",
    "extensions": [
      "pfr"
    ]
  },
  "application/font-woff": {
    "source": "iana",
    "compressible": false
  },
  "application/framework-attributes+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/geo+json": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "geojson"
    ]
  },
  "application/geo+json-seq": {
    "source": "iana"
  },
  "application/geopackage+sqlite3": {
    "source": "iana"
  },
  "application/geoxacml+json": {
    "source": "iana",
    "compressible": true
  },
  "application/geoxacml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/gltf-buffer": {
    "source": "iana"
  },
  "application/gml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "gml"
    ]
  },
  "application/gnap-binding-jws": {
    "source": "iana"
  },
  "application/gnap-binding-jwsd": {
    "source": "iana"
  },
  "application/gnap-binding-rotation-jws": {
    "source": "iana"
  },
  "application/gnap-binding-rotation-jwsd": {
    "source": "iana"
  },
  "application/gpx+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "gpx"
    ]
  },
  "application/grib": {
    "source": "iana"
  },
  "application/gxf": {
    "source": "apache",
    "extensions": [
      "gxf"
    ]
  },
  "application/gzip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "gz"
    ]
  },
  "application/h224": {
    "source": "iana"
  },
  "application/held+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/hjson": {
    "extensions": [
      "hjson"
    ]
  },
  "application/hl7v2+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/http": {
    "source": "iana"
  },
  "application/hyperstudio": {
    "source": "iana",
    "extensions": [
      "stk"
    ]
  },
  "application/ibe-key-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/ibe-pkg-reply+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/ibe-pp-data": {
    "source": "iana"
  },
  "application/iges": {
    "source": "iana"
  },
  "application/im-iscomposing+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/index": {
    "source": "iana"
  },
  "application/index.cmd": {
    "source": "iana"
  },
  "application/index.obj": {
    "source": "iana"
  },
  "application/index.response": {
    "source": "iana"
  },
  "application/index.vnd": {
    "source": "iana"
  },
  "application/inkml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ink",
      "inkml"
    ]
  },
  "application/iotp": {
    "source": "iana"
  },
  "application/ipfix": {
    "source": "iana",
    "extensions": [
      "ipfix"
    ]
  },
  "application/ipp": {
    "source": "iana"
  },
  "application/isup": {
    "source": "iana"
  },
  "application/its+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "its"
    ]
  },
  "application/java-archive": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "jar",
      "war",
      "ear"
    ]
  },
  "application/java-serialized-object": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "ser"
    ]
  },
  "application/java-vm": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "class"
    ]
  },
  "application/javascript": {
    "source": "apache",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "js"
    ]
  },
  "application/jf2feed+json": {
    "source": "iana",
    "compressible": true
  },
  "application/jose": {
    "source": "iana"
  },
  "application/jose+json": {
    "source": "iana",
    "compressible": true
  },
  "application/jrd+json": {
    "source": "iana",
    "compressible": true
  },
  "application/jscalendar+json": {
    "source": "iana",
    "compressible": true
  },
  "application/jscontact+json": {
    "source": "iana",
    "compressible": true
  },
  "application/json": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "json",
      "map"
    ]
  },
  "application/json-patch+json": {
    "source": "iana",
    "compressible": true
  },
  "application/json-seq": {
    "source": "iana"
  },
  "application/json5": {
    "extensions": [
      "json5"
    ]
  },
  "application/jsonml+json": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "jsonml"
    ]
  },
  "application/jsonpath": {
    "source": "iana"
  },
  "application/jwk+json": {
    "source": "iana",
    "compressible": true
  },
  "application/jwk-set+json": {
    "source": "iana",
    "compressible": true
  },
  "application/jwt": {
    "source": "iana"
  },
  "application/kpml-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/kpml-response+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/ld+json": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "jsonld"
    ]
  },
  "application/lgr+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "lgr"
    ]
  },
  "application/link-format": {
    "source": "iana"
  },
  "application/linkset": {
    "source": "iana"
  },
  "application/linkset+json": {
    "source": "iana",
    "compressible": true
  },
  "application/load-control+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/logout+jwt": {
    "source": "iana"
  },
  "application/lost+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "lostxml"
    ]
  },
  "application/lostsync+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/lpf+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/lxf": {
    "source": "iana"
  },
  "application/mac-binhex40": {
    "source": "iana",
    "extensions": [
      "hqx"
    ]
  },
  "application/mac-compactpro": {
    "source": "apache",
    "extensions": [
      "cpt"
    ]
  },
  "application/macwriteii": {
    "source": "iana"
  },
  "application/mads+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mads"
    ]
  },
  "application/manifest+json": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "webmanifest"
    ]
  },
  "application/marc": {
    "source": "iana",
    "extensions": [
      "mrc"
    ]
  },
  "application/marcxml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mrcx"
    ]
  },
  "application/mathematica": {
    "source": "iana",
    "extensions": [
      "ma",
      "nb",
      "mb"
    ]
  },
  "application/mathml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mathml"
    ]
  },
  "application/mathml-content+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mathml-presentation+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-associated-procedure-description+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-deregister+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-envelope+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-msk+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-msk-response+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-protection-description+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-reception-report+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-register+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-register-response+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-schedule+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbms-user-service-description+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mbox": {
    "source": "iana",
    "extensions": [
      "mbox"
    ]
  },
  "application/media-policy-dataset+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mpf"
    ]
  },
  "application/media_control+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mediaservercontrol+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mscml"
    ]
  },
  "application/merge-patch+json": {
    "source": "iana",
    "compressible": true
  },
  "application/metalink+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "metalink"
    ]
  },
  "application/metalink4+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "meta4"
    ]
  },
  "application/mets+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mets"
    ]
  },
  "application/mf4": {
    "source": "iana"
  },
  "application/mikey": {
    "source": "iana"
  },
  "application/mipc": {
    "source": "iana"
  },
  "application/missing-blocks+cbor-seq": {
    "source": "iana"
  },
  "application/mmt-aei+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "maei"
    ]
  },
  "application/mmt-usd+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "musd"
    ]
  },
  "application/mods+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mods"
    ]
  },
  "application/moss-keys": {
    "source": "iana"
  },
  "application/moss-signature": {
    "source": "iana"
  },
  "application/mosskey-data": {
    "source": "iana"
  },
  "application/mosskey-request": {
    "source": "iana"
  },
  "application/mp21": {
    "source": "iana",
    "extensions": [
      "m21",
      "mp21"
    ]
  },
  "application/mp4": {
    "source": "iana",
    "extensions": [
      "mp4",
      "mpg4",
      "mp4s",
      "m4p"
    ]
  },
  "application/mpeg4-generic": {
    "source": "iana"
  },
  "application/mpeg4-iod": {
    "source": "iana"
  },
  "application/mpeg4-iod-xmt": {
    "source": "iana"
  },
  "application/mrb-consumer+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/mrb-publish+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/msc-ivr+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/msc-mixer+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/msix": {
    "compressible": false,
    "extensions": [
      "msix"
    ]
  },
  "application/msixbundle": {
    "compressible": false,
    "extensions": [
      "msixbundle"
    ]
  },
  "application/msword": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "doc",
      "dot"
    ]
  },
  "application/mud+json": {
    "source": "iana",
    "compressible": true
  },
  "application/multipart-core": {
    "source": "iana"
  },
  "application/mxf": {
    "source": "iana",
    "extensions": [
      "mxf"
    ]
  },
  "application/n-quads": {
    "source": "iana",
    "extensions": [
      "nq"
    ]
  },
  "application/n-triples": {
    "source": "iana",
    "extensions": [
      "nt"
    ]
  },
  "application/nasdata": {
    "source": "iana"
  },
  "application/news-checkgroups": {
    "source": "iana",
    "charset": "US-ASCII"
  },
  "application/news-groupinfo": {
    "source": "iana",
    "charset": "US-ASCII"
  },
  "application/news-transmission": {
    "source": "iana"
  },
  "application/nlsml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/node": {
    "source": "iana",
    "extensions": [
      "cjs"
    ]
  },
  "application/nss": {
    "source": "iana"
  },
  "application/oauth-authz-req+jwt": {
    "source": "iana"
  },
  "application/oblivious-dns-message": {
    "source": "iana"
  },
  "application/ocsp-request": {
    "source": "iana"
  },
  "application/ocsp-response": {
    "source": "iana"
  },
  "application/octet-stream": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "bin",
      "dms",
      "lrf",
      "mar",
      "so",
      "dist",
      "distz",
      "pkg",
      "bpk",
      "dump",
      "elc",
      "deploy",
      "exe",
      "dll",
      "deb",
      "dmg",
      "iso",
      "img",
      "msi",
      "msp",
      "msm",
      "buffer"
    ]
  },
  "application/oda": {
    "source": "iana",
    "extensions": [
      "oda"
    ]
  },
  "application/odm+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/odx": {
    "source": "iana"
  },
  "application/oebps-package+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "opf"
    ]
  },
  "application/ogg": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "ogx"
    ]
  },
  "application/ohttp-keys": {
    "source": "iana"
  },
  "application/omdoc+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "omdoc"
    ]
  },
  "application/onenote": {
    "source": "apache",
    "extensions": [
      "onetoc",
      "onetoc2",
      "onetmp",
      "onepkg"
    ]
  },
  "application/opc-nodeset+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/oscore": {
    "source": "iana"
  },
  "application/oxps": {
    "source": "iana",
    "extensions": [
      "oxps"
    ]
  },
  "application/p21": {
    "source": "iana"
  },
  "application/p21+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/p2p-overlay+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "relo"
    ]
  },
  "application/parityfec": {
    "source": "iana"
  },
  "application/passport": {
    "source": "iana"
  },
  "application/patch-ops-error+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xer"
    ]
  },
  "application/pdf": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "pdf"
    ]
  },
  "application/pdx": {
    "source": "iana"
  },
  "application/pem-certificate-chain": {
    "source": "iana"
  },
  "application/pgp-encrypted": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "pgp"
    ]
  },
  "application/pgp-keys": {
    "source": "iana",
    "extensions": [
      "asc"
    ]
  },
  "application/pgp-signature": {
    "source": "iana",
    "extensions": [
      "sig",
      "asc"
    ]
  },
  "application/pics-rules": {
    "source": "apache",
    "extensions": [
      "prf"
    ]
  },
  "application/pidf+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/pidf-diff+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/pkcs10": {
    "source": "iana",
    "extensions": [
      "p10"
    ]
  },
  "application/pkcs12": {
    "source": "iana"
  },
  "application/pkcs7-mime": {
    "source": "iana",
    "extensions": [
      "p7m",
      "p7c"
    ]
  },
  "application/pkcs7-signature": {
    "source": "iana",
    "extensions": [
      "p7s"
    ]
  },
  "application/pkcs8": {
    "source": "iana",
    "extensions": [
      "p8"
    ]
  },
  "application/pkcs8-encrypted": {
    "source": "iana"
  },
  "application/pkix-attr-cert": {
    "source": "iana",
    "extensions": [
      "ac"
    ]
  },
  "application/pkix-cert": {
    "source": "iana",
    "extensions": [
      "cer"
    ]
  },
  "application/pkix-crl": {
    "source": "iana",
    "extensions": [
      "crl"
    ]
  },
  "application/pkix-pkipath": {
    "source": "iana",
    "extensions": [
      "pkipath"
    ]
  },
  "application/pkixcmp": {
    "source": "iana",
    "extensions": [
      "pki"
    ]
  },
  "application/pls+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "pls"
    ]
  },
  "application/poc-settings+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/postscript": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ai",
      "eps",
      "ps"
    ]
  },
  "application/ppsp-tracker+json": {
    "source": "iana",
    "compressible": true
  },
  "application/private-token-issuer-directory": {
    "source": "iana"
  },
  "application/private-token-request": {
    "source": "iana"
  },
  "application/private-token-response": {
    "source": "iana"
  },
  "application/problem+json": {
    "source": "iana",
    "compressible": true
  },
  "application/problem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/provenance+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "provx"
    ]
  },
  "application/prs.alvestrand.titrax-sheet": {
    "source": "iana"
  },
  "application/prs.cww": {
    "source": "iana",
    "extensions": [
      "cww"
    ]
  },
  "application/prs.cyn": {
    "source": "iana",
    "charset": "7-BIT"
  },
  "application/prs.hpub+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/prs.implied-document+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/prs.implied-executable": {
    "source": "iana"
  },
  "application/prs.implied-object+json": {
    "source": "iana",
    "compressible": true
  },
  "application/prs.implied-object+json-seq": {
    "source": "iana"
  },
  "application/prs.implied-object+yaml": {
    "source": "iana"
  },
  "application/prs.implied-structure": {
    "source": "iana"
  },
  "application/prs.nprend": {
    "source": "iana"
  },
  "application/prs.plucker": {
    "source": "iana"
  },
  "application/prs.rdf-xml-crypt": {
    "source": "iana"
  },
  "application/prs.vcfbzip2": {
    "source": "iana"
  },
  "application/prs.xsf+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xsf"
    ]
  },
  "application/pskc+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "pskcxml"
    ]
  },
  "application/pvd+json": {
    "source": "iana",
    "compressible": true
  },
  "application/qsig": {
    "source": "iana"
  },
  "application/raml+yaml": {
    "compressible": true,
    "extensions": [
      "raml"
    ]
  },
  "application/raptorfec": {
    "source": "iana"
  },
  "application/rdap+json": {
    "source": "iana",
    "compressible": true
  },
  "application/rdf+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rdf",
      "owl"
    ]
  },
  "application/reginfo+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rif"
    ]
  },
  "application/relax-ng-compact-syntax": {
    "source": "iana",
    "extensions": [
      "rnc"
    ]
  },
  "application/remote-printing": {
    "source": "apache"
  },
  "application/reputon+json": {
    "source": "iana",
    "compressible": true
  },
  "application/resource-lists+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rl"
    ]
  },
  "application/resource-lists-diff+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rld"
    ]
  },
  "application/rfc+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/riscos": {
    "source": "iana"
  },
  "application/rlmi+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/rls-services+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rs"
    ]
  },
  "application/route-apd+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rapd"
    ]
  },
  "application/route-s-tsid+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "sls"
    ]
  },
  "application/route-usd+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rusd"
    ]
  },
  "application/rpki-checklist": {
    "source": "iana"
  },
  "application/rpki-ghostbusters": {
    "source": "iana",
    "extensions": [
      "gbr"
    ]
  },
  "application/rpki-manifest": {
    "source": "iana",
    "extensions": [
      "mft"
    ]
  },
  "application/rpki-publication": {
    "source": "iana"
  },
  "application/rpki-roa": {
    "source": "iana",
    "extensions": [
      "roa"
    ]
  },
  "application/rpki-signed-tal": {
    "source": "iana"
  },
  "application/rpki-updown": {
    "source": "iana"
  },
  "application/rsd+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "rsd"
    ]
  },
  "application/rss+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "rss"
    ]
  },
  "application/rtf": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rtf"
    ]
  },
  "application/rtploopback": {
    "source": "iana"
  },
  "application/rtx": {
    "source": "iana"
  },
  "application/samlassertion+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/samlmetadata+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/sarif+json": {
    "source": "iana",
    "compressible": true
  },
  "application/sarif-external-properties+json": {
    "source": "iana",
    "compressible": true
  },
  "application/sbe": {
    "source": "iana"
  },
  "application/sbml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "sbml"
    ]
  },
  "application/scaip+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/scim+json": {
    "source": "iana",
    "compressible": true
  },
  "application/scvp-cv-request": {
    "source": "iana",
    "extensions": [
      "scq"
    ]
  },
  "application/scvp-cv-response": {
    "source": "iana",
    "extensions": [
      "scs"
    ]
  },
  "application/scvp-vp-request": {
    "source": "iana",
    "extensions": [
      "spq"
    ]
  },
  "application/scvp-vp-response": {
    "source": "iana",
    "extensions": [
      "spp"
    ]
  },
  "application/sdp": {
    "source": "iana",
    "extensions": [
      "sdp"
    ]
  },
  "application/secevent+jwt": {
    "source": "iana"
  },
  "application/senml+cbor": {
    "source": "iana"
  },
  "application/senml+json": {
    "source": "iana",
    "compressible": true
  },
  "application/senml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "senmlx"
    ]
  },
  "application/senml-etch+cbor": {
    "source": "iana"
  },
  "application/senml-etch+json": {
    "source": "iana",
    "compressible": true
  },
  "application/senml-exi": {
    "source": "iana"
  },
  "application/sensml+cbor": {
    "source": "iana"
  },
  "application/sensml+json": {
    "source": "iana",
    "compressible": true
  },
  "application/sensml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "sensmlx"
    ]
  },
  "application/sensml-exi": {
    "source": "iana"
  },
  "application/sep+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/sep-exi": {
    "source": "iana"
  },
  "application/session-info": {
    "source": "iana"
  },
  "application/set-payment": {
    "source": "iana"
  },
  "application/set-payment-initiation": {
    "source": "iana",
    "extensions": [
      "setpay"
    ]
  },
  "application/set-registration": {
    "source": "iana"
  },
  "application/set-registration-initiation": {
    "source": "iana",
    "extensions": [
      "setreg"
    ]
  },
  "application/sgml": {
    "source": "iana"
  },
  "application/sgml-open-catalog": {
    "source": "iana"
  },
  "application/shf+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "shf"
    ]
  },
  "application/sieve": {
    "source": "iana",
    "extensions": [
      "siv",
      "sieve"
    ]
  },
  "application/simple-filter+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/simple-message-summary": {
    "source": "iana"
  },
  "application/simplesymbolcontainer": {
    "source": "iana"
  },
  "application/sipc": {
    "source": "iana"
  },
  "application/slate": {
    "source": "iana"
  },
  "application/smil": {
    "source": "apache"
  },
  "application/smil+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "smi",
      "smil"
    ]
  },
  "application/smpte336m": {
    "source": "iana"
  },
  "application/soap+fastinfoset": {
    "source": "iana"
  },
  "application/soap+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/sparql-query": {
    "source": "iana",
    "extensions": [
      "rq"
    ]
  },
  "application/sparql-results+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "srx"
    ]
  },
  "application/spdx+json": {
    "source": "iana",
    "compressible": true
  },
  "application/spirits-event+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/sql": {
    "source": "iana",
    "extensions": [
      "sql"
    ]
  },
  "application/srgs": {
    "source": "iana",
    "extensions": [
      "gram"
    ]
  },
  "application/srgs+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "grxml"
    ]
  },
  "application/sru+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "sru"
    ]
  },
  "application/ssdl+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "ssdl"
    ]
  },
  "application/ssml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ssml"
    ]
  },
  "application/st2110-41": {
    "source": "iana"
  },
  "application/stix+json": {
    "source": "iana",
    "compressible": true
  },
  "application/stratum": {
    "source": "iana"
  },
  "application/swid+cbor": {
    "source": "iana"
  },
  "application/swid+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "swidtag"
    ]
  },
  "application/tamp-apex-update": {
    "source": "iana"
  },
  "application/tamp-apex-update-confirm": {
    "source": "iana"
  },
  "application/tamp-community-update": {
    "source": "iana"
  },
  "application/tamp-community-update-confirm": {
    "source": "iana"
  },
  "application/tamp-error": {
    "source": "iana"
  },
  "application/tamp-sequence-adjust": {
    "source": "iana"
  },
  "application/tamp-sequence-adjust-confirm": {
    "source": "iana"
  },
  "application/tamp-status-query": {
    "source": "iana"
  },
  "application/tamp-status-response": {
    "source": "iana"
  },
  "application/tamp-update": {
    "source": "iana"
  },
  "application/tamp-update-confirm": {
    "source": "iana"
  },
  "application/tar": {
    "compressible": true
  },
  "application/taxii+json": {
    "source": "iana",
    "compressible": true
  },
  "application/td+json": {
    "source": "iana",
    "compressible": true
  },
  "application/tei+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "tei",
      "teicorpus"
    ]
  },
  "application/tetra_isi": {
    "source": "iana"
  },
  "application/thraud+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "tfi"
    ]
  },
  "application/timestamp-query": {
    "source": "iana"
  },
  "application/timestamp-reply": {
    "source": "iana"
  },
  "application/timestamped-data": {
    "source": "iana",
    "extensions": [
      "tsd"
    ]
  },
  "application/tlsrpt+gzip": {
    "source": "iana"
  },
  "application/tlsrpt+json": {
    "source": "iana",
    "compressible": true
  },
  "application/tm+json": {
    "source": "iana",
    "compressible": true
  },
  "application/tnauthlist": {
    "source": "iana"
  },
  "application/token-introspection+jwt": {
    "source": "iana"
  },
  "application/toml": {
    "compressible": true,
    "extensions": [
      "toml"
    ]
  },
  "application/trickle-ice-sdpfrag": {
    "source": "iana"
  },
  "application/trig": {
    "source": "iana",
    "extensions": [
      "trig"
    ]
  },
  "application/ttml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ttml"
    ]
  },
  "application/tve-trigger": {
    "source": "iana"
  },
  "application/tzif": {
    "source": "iana"
  },
  "application/tzif-leap": {
    "source": "iana"
  },
  "application/ubjson": {
    "compressible": false,
    "extensions": [
      "ubj"
    ]
  },
  "application/ulpfec": {
    "source": "iana"
  },
  "application/urc-grpsheet+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/urc-ressheet+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rsheet"
    ]
  },
  "application/urc-targetdesc+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "td"
    ]
  },
  "application/urc-uisocketdesc+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vc": {
    "source": "iana"
  },
  "application/vcard+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vcard+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vemmi": {
    "source": "iana"
  },
  "application/vividence.scriptfile": {
    "source": "apache"
  },
  "application/vnd.1000minds.decision-model+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "1km"
    ]
  },
  "application/vnd.1ob": {
    "source": "iana"
  },
  "application/vnd.3gpp-prose+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp-prose-pc3a+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp-prose-pc3ach+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp-prose-pc3ch+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp-prose-pc8+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp-v2x-local-service-information": {
    "source": "iana"
  },
  "application/vnd.3gpp.5gnas": {
    "source": "iana"
  },
  "application/vnd.3gpp.5gsa2x": {
    "source": "iana"
  },
  "application/vnd.3gpp.5gsa2x-local-service-information": {
    "source": "iana"
  },
  "application/vnd.3gpp.access-transfer-events+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.bsf+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.crs+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.current-location-discovery+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.gmop+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.gtpc": {
    "source": "iana"
  },
  "application/vnd.3gpp.interworking-data": {
    "source": "iana"
  },
  "application/vnd.3gpp.lpp": {
    "source": "iana"
  },
  "application/vnd.3gpp.mc-signalling-ear": {
    "source": "iana"
  },
  "application/vnd.3gpp.mcdata-affiliation-command+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcdata-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcdata-msgstore-ctrl-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcdata-payload": {
    "source": "iana"
  },
  "application/vnd.3gpp.mcdata-regroup+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcdata-service-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcdata-signalling": {
    "source": "iana"
  },
  "application/vnd.3gpp.mcdata-ue-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcdata-user-profile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-affiliation-command+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-floor-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-location-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-mbms-usage-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-regroup+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-service-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-signed+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-ue-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-ue-init-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcptt-user-profile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-affiliation-command+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-location-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-mbms-usage-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-regroup+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-service-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-transmission-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-ue-config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mcvideo-user-profile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.mid-call+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.ngap": {
    "source": "iana"
  },
  "application/vnd.3gpp.pfcp": {
    "source": "iana"
  },
  "application/vnd.3gpp.pic-bw-large": {
    "source": "iana",
    "extensions": [
      "plb"
    ]
  },
  "application/vnd.3gpp.pic-bw-small": {
    "source": "iana",
    "extensions": [
      "psb"
    ]
  },
  "application/vnd.3gpp.pic-bw-var": {
    "source": "iana",
    "extensions": [
      "pvb"
    ]
  },
  "application/vnd.3gpp.pinapp-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.s1ap": {
    "source": "iana"
  },
  "application/vnd.3gpp.seal-group-doc+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-location-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-mbms-usage-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-network-qos-management-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-ue-config-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-unicast-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.seal-user-profile-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.sms": {
    "source": "iana"
  },
  "application/vnd.3gpp.sms+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.srvcc-ext+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.srvcc-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.state-and-event-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.ussd+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp.v2x": {
    "source": "iana"
  },
  "application/vnd.3gpp.vae-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp2.bcmcsinfo+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.3gpp2.sms": {
    "source": "iana"
  },
  "application/vnd.3gpp2.tcap": {
    "source": "iana",
    "extensions": [
      "tcap"
    ]
  },
  "application/vnd.3lightssoftware.imagescal": {
    "source": "iana"
  },
  "application/vnd.3m.post-it-notes": {
    "source": "iana",
    "extensions": [
      "pwn"
    ]
  },
  "application/vnd.accpac.simply.aso": {
    "source": "iana",
    "extensions": [
      "aso"
    ]
  },
  "application/vnd.accpac.simply.imp": {
    "source": "iana",
    "extensions": [
      "imp"
    ]
  },
  "application/vnd.acm.addressxfer+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.acm.chatbot+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.acucobol": {
    "source": "iana",
    "extensions": [
      "acu"
    ]
  },
  "application/vnd.acucorp": {
    "source": "iana",
    "extensions": [
      "atc",
      "acutc"
    ]
  },
  "application/vnd.adobe.air-application-installer-package+zip": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "air"
    ]
  },
  "application/vnd.adobe.flash.movie": {
    "source": "iana"
  },
  "application/vnd.adobe.formscentral.fcdt": {
    "source": "iana",
    "extensions": [
      "fcdt"
    ]
  },
  "application/vnd.adobe.fxp": {
    "source": "iana",
    "extensions": [
      "fxp",
      "fxpl"
    ]
  },
  "application/vnd.adobe.partial-upload": {
    "source": "iana"
  },
  "application/vnd.adobe.xdp+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xdp"
    ]
  },
  "application/vnd.adobe.xfdf": {
    "source": "apache",
    "extensions": [
      "xfdf"
    ]
  },
  "application/vnd.aether.imp": {
    "source": "iana"
  },
  "application/vnd.afpc.afplinedata": {
    "source": "iana"
  },
  "application/vnd.afpc.afplinedata-pagedef": {
    "source": "iana"
  },
  "application/vnd.afpc.cmoca-cmresource": {
    "source": "iana"
  },
  "application/vnd.afpc.foca-charset": {
    "source": "iana"
  },
  "application/vnd.afpc.foca-codedfont": {
    "source": "iana"
  },
  "application/vnd.afpc.foca-codepage": {
    "source": "iana"
  },
  "application/vnd.afpc.modca": {
    "source": "iana"
  },
  "application/vnd.afpc.modca-cmtable": {
    "source": "iana"
  },
  "application/vnd.afpc.modca-formdef": {
    "source": "iana"
  },
  "application/vnd.afpc.modca-mediummap": {
    "source": "iana"
  },
  "application/vnd.afpc.modca-objectcontainer": {
    "source": "iana"
  },
  "application/vnd.afpc.modca-overlay": {
    "source": "iana"
  },
  "application/vnd.afpc.modca-pagesegment": {
    "source": "iana"
  },
  "application/vnd.age": {
    "source": "iana",
    "extensions": [
      "age"
    ]
  },
  "application/vnd.ah-barcode": {
    "source": "apache"
  },
  "application/vnd.ahead.space": {
    "source": "iana",
    "extensions": [
      "ahead"
    ]
  },
  "application/vnd.airzip.filesecure.azf": {
    "source": "iana",
    "extensions": [
      "azf"
    ]
  },
  "application/vnd.airzip.filesecure.azs": {
    "source": "iana",
    "extensions": [
      "azs"
    ]
  },
  "application/vnd.amadeus+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.amazon.ebook": {
    "source": "apache",
    "extensions": [
      "azw"
    ]
  },
  "application/vnd.amazon.mobi8-ebook": {
    "source": "iana"
  },
  "application/vnd.americandynamics.acc": {
    "source": "iana",
    "extensions": [
      "acc"
    ]
  },
  "application/vnd.amiga.ami": {
    "source": "iana",
    "extensions": [
      "ami"
    ]
  },
  "application/vnd.amundsen.maze+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.android.ota": {
    "source": "iana"
  },
  "application/vnd.android.package-archive": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "apk"
    ]
  },
  "application/vnd.anki": {
    "source": "iana"
  },
  "application/vnd.anser-web-certificate-issue-initiation": {
    "source": "iana",
    "extensions": [
      "cii"
    ]
  },
  "application/vnd.anser-web-funds-transfer-initiation": {
    "source": "apache",
    "extensions": [
      "fti"
    ]
  },
  "application/vnd.antix.game-component": {
    "source": "iana",
    "extensions": [
      "atx"
    ]
  },
  "application/vnd.apache.arrow.file": {
    "source": "iana"
  },
  "application/vnd.apache.arrow.stream": {
    "source": "iana"
  },
  "application/vnd.apache.parquet": {
    "source": "iana"
  },
  "application/vnd.apache.thrift.binary": {
    "source": "iana"
  },
  "application/vnd.apache.thrift.compact": {
    "source": "iana"
  },
  "application/vnd.apache.thrift.json": {
    "source": "iana"
  },
  "application/vnd.apexlang": {
    "source": "iana"
  },
  "application/vnd.api+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.aplextor.warrp+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.apothekende.reservation+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.apple.installer+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mpkg"
    ]
  },
  "application/vnd.apple.keynote": {
    "source": "iana",
    "extensions": [
      "key"
    ]
  },
  "application/vnd.apple.mpegurl": {
    "source": "iana",
    "extensions": [
      "m3u8"
    ]
  },
  "application/vnd.apple.numbers": {
    "source": "iana",
    "extensions": [
      "numbers"
    ]
  },
  "application/vnd.apple.pages": {
    "source": "iana",
    "extensions": [
      "pages"
    ]
  },
  "application/vnd.apple.pkpass": {
    "compressible": false,
    "extensions": [
      "pkpass"
    ]
  },
  "application/vnd.arastra.swi": {
    "source": "apache"
  },
  "application/vnd.aristanetworks.swi": {
    "source": "iana",
    "extensions": [
      "swi"
    ]
  },
  "application/vnd.artisan+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.artsquare": {
    "source": "iana"
  },
  "application/vnd.astraea-software.iota": {
    "source": "iana",
    "extensions": [
      "iota"
    ]
  },
  "application/vnd.audiograph": {
    "source": "iana",
    "extensions": [
      "aep"
    ]
  },
  "application/vnd.autopackage": {
    "source": "iana"
  },
  "application/vnd.avalon+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.avistar+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.balsamiq.bmml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "bmml"
    ]
  },
  "application/vnd.balsamiq.bmpr": {
    "source": "iana"
  },
  "application/vnd.banana-accounting": {
    "source": "iana"
  },
  "application/vnd.bbf.usp.error": {
    "source": "iana"
  },
  "application/vnd.bbf.usp.msg": {
    "source": "iana"
  },
  "application/vnd.bbf.usp.msg+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.bekitzur-stech+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.belightsoft.lhzd+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.belightsoft.lhzl+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.bint.med-content": {
    "source": "iana"
  },
  "application/vnd.biopax.rdf+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.blink-idb-value-wrapper": {
    "source": "iana"
  },
  "application/vnd.blueice.multipass": {
    "source": "iana",
    "extensions": [
      "mpm"
    ]
  },
  "application/vnd.bluetooth.ep.oob": {
    "source": "iana"
  },
  "application/vnd.bluetooth.le.oob": {
    "source": "iana"
  },
  "application/vnd.bmi": {
    "source": "iana",
    "extensions": [
      "bmi"
    ]
  },
  "application/vnd.bpf": {
    "source": "iana"
  },
  "application/vnd.bpf3": {
    "source": "iana"
  },
  "application/vnd.businessobjects": {
    "source": "iana",
    "extensions": [
      "rep"
    ]
  },
  "application/vnd.byu.uapi+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.bzip3": {
    "source": "iana"
  },
  "application/vnd.c3voc.schedule+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.cab-jscript": {
    "source": "iana"
  },
  "application/vnd.canon-cpdl": {
    "source": "iana"
  },
  "application/vnd.canon-lips": {
    "source": "iana"
  },
  "application/vnd.capasystems-pg+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.cendio.thinlinc.clientconf": {
    "source": "iana"
  },
  "application/vnd.century-systems.tcp_stream": {
    "source": "iana"
  },
  "application/vnd.chemdraw+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "cdxml"
    ]
  },
  "application/vnd.chess-pgn": {
    "source": "iana"
  },
  "application/vnd.chipnuts.karaoke-mmd": {
    "source": "iana",
    "extensions": [
      "mmd"
    ]
  },
  "application/vnd.ciedi": {
    "source": "iana"
  },
  "application/vnd.cinderella": {
    "source": "iana",
    "extensions": [
      "cdy"
    ]
  },
  "application/vnd.cirpack.isdn-ext": {
    "source": "iana"
  },
  "application/vnd.citationstyles.style+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "csl"
    ]
  },
  "application/vnd.claymore": {
    "source": "iana",
    "extensions": [
      "cla"
    ]
  },
  "application/vnd.cloanto.rp9": {
    "source": "iana",
    "extensions": [
      "rp9"
    ]
  },
  "application/vnd.clonk.c4group": {
    "source": "iana",
    "extensions": [
      "c4g",
      "c4d",
      "c4f",
      "c4p",
      "c4u"
    ]
  },
  "application/vnd.cluetrust.cartomobile-config": {
    "source": "iana",
    "extensions": [
      "c11amc"
    ]
  },
  "application/vnd.cluetrust.cartomobile-config-pkg": {
    "source": "iana",
    "extensions": [
      "c11amz"
    ]
  },
  "application/vnd.cncf.helm.chart.content.v1.tar+gzip": {
    "source": "iana"
  },
  "application/vnd.cncf.helm.chart.provenance.v1.prov": {
    "source": "iana"
  },
  "application/vnd.cncf.helm.config.v1+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.coffeescript": {
    "source": "iana"
  },
  "application/vnd.collabio.xodocuments.document": {
    "source": "iana"
  },
  "application/vnd.collabio.xodocuments.document-template": {
    "source": "iana"
  },
  "application/vnd.collabio.xodocuments.presentation": {
    "source": "iana"
  },
  "application/vnd.collabio.xodocuments.presentation-template": {
    "source": "iana"
  },
  "application/vnd.collabio.xodocuments.spreadsheet": {
    "source": "iana"
  },
  "application/vnd.collabio.xodocuments.spreadsheet-template": {
    "source": "iana"
  },
  "application/vnd.collection+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.collection.doc+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.collection.next+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.comicbook+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.comicbook-rar": {
    "source": "iana"
  },
  "application/vnd.commerce-battelle": {
    "source": "iana"
  },
  "application/vnd.commonspace": {
    "source": "iana",
    "extensions": [
      "csp"
    ]
  },
  "application/vnd.contact.cmsg": {
    "source": "iana",
    "extensions": [
      "cdbcmsg"
    ]
  },
  "application/vnd.coreos.ignition+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.cosmocaller": {
    "source": "iana",
    "extensions": [
      "cmc"
    ]
  },
  "application/vnd.crick.clicker": {
    "source": "iana",
    "extensions": [
      "clkx"
    ]
  },
  "application/vnd.crick.clicker.keyboard": {
    "source": "iana",
    "extensions": [
      "clkk"
    ]
  },
  "application/vnd.crick.clicker.palette": {
    "source": "iana",
    "extensions": [
      "clkp"
    ]
  },
  "application/vnd.crick.clicker.template": {
    "source": "iana",
    "extensions": [
      "clkt"
    ]
  },
  "application/vnd.crick.clicker.wordbank": {
    "source": "iana",
    "extensions": [
      "clkw"
    ]
  },
  "application/vnd.criticaltools.wbs+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "wbs"
    ]
  },
  "application/vnd.cryptii.pipe+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.crypto-shade-file": {
    "source": "iana"
  },
  "application/vnd.cryptomator.encrypted": {
    "source": "iana"
  },
  "application/vnd.cryptomator.vault": {
    "source": "iana"
  },
  "application/vnd.ctc-posml": {
    "source": "iana",
    "extensions": [
      "pml"
    ]
  },
  "application/vnd.ctct.ws+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.cups-pdf": {
    "source": "iana"
  },
  "application/vnd.cups-postscript": {
    "source": "iana"
  },
  "application/vnd.cups-ppd": {
    "source": "iana",
    "extensions": [
      "ppd"
    ]
  },
  "application/vnd.cups-raster": {
    "source": "iana"
  },
  "application/vnd.cups-raw": {
    "source": "iana"
  },
  "application/vnd.curl": {
    "source": "iana"
  },
  "application/vnd.curl.car": {
    "source": "apache",
    "extensions": [
      "car"
    ]
  },
  "application/vnd.curl.pcurl": {
    "source": "apache",
    "extensions": [
      "pcurl"
    ]
  },
  "application/vnd.cyan.dean.root+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.cybank": {
    "source": "iana"
  },
  "application/vnd.cyclonedx+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.cyclonedx+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.d2l.coursepackage1p0+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.d3m-dataset": {
    "source": "iana"
  },
  "application/vnd.d3m-problem": {
    "source": "iana"
  },
  "application/vnd.dart": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "dart"
    ]
  },
  "application/vnd.data-vision.rdz": {
    "source": "iana",
    "extensions": [
      "rdz"
    ]
  },
  "application/vnd.datalog": {
    "source": "iana"
  },
  "application/vnd.datapackage+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dataresource+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dbf": {
    "source": "iana",
    "extensions": [
      "dbf"
    ]
  },
  "application/vnd.debian.binary-package": {
    "source": "iana"
  },
  "application/vnd.dece.data": {
    "source": "iana",
    "extensions": [
      "uvf",
      "uvvf",
      "uvd",
      "uvvd"
    ]
  },
  "application/vnd.dece.ttml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "uvt",
      "uvvt"
    ]
  },
  "application/vnd.dece.unspecified": {
    "source": "iana",
    "extensions": [
      "uvx",
      "uvvx"
    ]
  },
  "application/vnd.dece.zip": {
    "source": "iana",
    "extensions": [
      "uvz",
      "uvvz"
    ]
  },
  "application/vnd.denovo.fcselayout-link": {
    "source": "iana",
    "extensions": [
      "fe_launch"
    ]
  },
  "application/vnd.desmume.movie": {
    "source": "iana"
  },
  "application/vnd.dir-bi.plate-dl-nosuffix": {
    "source": "iana"
  },
  "application/vnd.dm.delegation+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dna": {
    "source": "iana",
    "extensions": [
      "dna"
    ]
  },
  "application/vnd.document+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dolby.mlp": {
    "source": "apache",
    "extensions": [
      "mlp"
    ]
  },
  "application/vnd.dolby.mobile.1": {
    "source": "iana"
  },
  "application/vnd.dolby.mobile.2": {
    "source": "iana"
  },
  "application/vnd.doremir.scorecloud-binary-document": {
    "source": "iana"
  },
  "application/vnd.dpgraph": {
    "source": "iana",
    "extensions": [
      "dpg"
    ]
  },
  "application/vnd.dreamfactory": {
    "source": "iana",
    "extensions": [
      "dfac"
    ]
  },
  "application/vnd.drive+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ds-keypoint": {
    "source": "apache",
    "extensions": [
      "kpxx"
    ]
  },
  "application/vnd.dtg.local": {
    "source": "iana"
  },
  "application/vnd.dtg.local.flash": {
    "source": "iana"
  },
  "application/vnd.dtg.local.html": {
    "source": "iana"
  },
  "application/vnd.dvb.ait": {
    "source": "iana",
    "extensions": [
      "ait"
    ]
  },
  "application/vnd.dvb.dvbisl+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.dvbj": {
    "source": "iana"
  },
  "application/vnd.dvb.esgcontainer": {
    "source": "iana"
  },
  "application/vnd.dvb.ipdcdftnotifaccess": {
    "source": "iana"
  },
  "application/vnd.dvb.ipdcesgaccess": {
    "source": "iana"
  },
  "application/vnd.dvb.ipdcesgaccess2": {
    "source": "iana"
  },
  "application/vnd.dvb.ipdcesgpdd": {
    "source": "iana"
  },
  "application/vnd.dvb.ipdcroaming": {
    "source": "iana"
  },
  "application/vnd.dvb.iptv.alfec-base": {
    "source": "iana"
  },
  "application/vnd.dvb.iptv.alfec-enhancement": {
    "source": "iana"
  },
  "application/vnd.dvb.notif-aggregate-root+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.notif-container+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.notif-generic+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.notif-ia-msglist+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.notif-ia-registration-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.notif-ia-registration-response+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.notif-init+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.dvb.pfr": {
    "source": "iana"
  },
  "application/vnd.dvb.service": {
    "source": "iana",
    "extensions": [
      "svc"
    ]
  },
  "application/vnd.dxr": {
    "source": "iana"
  },
  "application/vnd.dynageo": {
    "source": "iana",
    "extensions": [
      "geo"
    ]
  },
  "application/vnd.dzr": {
    "source": "iana"
  },
  "application/vnd.easykaraoke.cdgdownload": {
    "source": "iana"
  },
  "application/vnd.ecdis-update": {
    "source": "iana"
  },
  "application/vnd.ecip.rlp": {
    "source": "iana"
  },
  "application/vnd.eclipse.ditto+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ecowin.chart": {
    "source": "iana",
    "extensions": [
      "mag"
    ]
  },
  "application/vnd.ecowin.filerequest": {
    "source": "iana"
  },
  "application/vnd.ecowin.fileupdate": {
    "source": "iana"
  },
  "application/vnd.ecowin.series": {
    "source": "iana"
  },
  "application/vnd.ecowin.seriesrequest": {
    "source": "iana"
  },
  "application/vnd.ecowin.seriesupdate": {
    "source": "iana"
  },
  "application/vnd.efi.img": {
    "source": "iana"
  },
  "application/vnd.efi.iso": {
    "source": "iana"
  },
  "application/vnd.eln+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.emclient.accessrequest+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.enliven": {
    "source": "iana",
    "extensions": [
      "nml"
    ]
  },
  "application/vnd.enphase.envoy": {
    "source": "iana"
  },
  "application/vnd.eprints.data+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.epson.esf": {
    "source": "iana",
    "extensions": [
      "esf"
    ]
  },
  "application/vnd.epson.msf": {
    "source": "iana",
    "extensions": [
      "msf"
    ]
  },
  "application/vnd.epson.quickanime": {
    "source": "iana",
    "extensions": [
      "qam"
    ]
  },
  "application/vnd.epson.salt": {
    "source": "iana",
    "extensions": [
      "slt"
    ]
  },
  "application/vnd.epson.ssf": {
    "source": "iana",
    "extensions": [
      "ssf"
    ]
  },
  "application/vnd.ericsson.quickcall": {
    "source": "iana"
  },
  "application/vnd.erofs": {
    "source": "iana"
  },
  "application/vnd.espass-espass+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.eszigno3+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "es3",
      "et3"
    ]
  },
  "application/vnd.etsi.aoc+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.asic-e+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.etsi.asic-s+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.etsi.cug+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvcommand+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvdiscovery+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvprofile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvsad-bc+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvsad-cod+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvsad-npvr+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvservice+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvsync+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.iptvueprofile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.mcid+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.mheg5": {
    "source": "iana"
  },
  "application/vnd.etsi.overload-control-policy-dataset+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.pstn+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.sci+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.simservs+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.timestamp-token": {
    "source": "iana"
  },
  "application/vnd.etsi.tsl+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.etsi.tsl.der": {
    "source": "iana"
  },
  "application/vnd.eu.kasparian.car+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.eudora.data": {
    "source": "iana"
  },
  "application/vnd.evolv.ecig.profile": {
    "source": "iana"
  },
  "application/vnd.evolv.ecig.settings": {
    "source": "iana"
  },
  "application/vnd.evolv.ecig.theme": {
    "source": "iana"
  },
  "application/vnd.exstream-empower+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.exstream-package": {
    "source": "iana"
  },
  "application/vnd.ezpix-album": {
    "source": "iana",
    "extensions": [
      "ez2"
    ]
  },
  "application/vnd.ezpix-package": {
    "source": "iana",
    "extensions": [
      "ez3"
    ]
  },
  "application/vnd.f-secure.mobile": {
    "source": "iana"
  },
  "application/vnd.familysearch.gedcom+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.fastcopy-disk-image": {
    "source": "iana"
  },
  "application/vnd.fdf": {
    "source": "apache",
    "extensions": [
      "fdf"
    ]
  },
  "application/vnd.fdsn.mseed": {
    "source": "iana",
    "extensions": [
      "mseed"
    ]
  },
  "application/vnd.fdsn.seed": {
    "source": "iana",
    "extensions": [
      "seed",
      "dataless"
    ]
  },
  "application/vnd.ffsns": {
    "source": "iana"
  },
  "application/vnd.ficlab.flb+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.filmit.zfc": {
    "source": "iana"
  },
  "application/vnd.fints": {
    "source": "iana"
  },
  "application/vnd.firemonkeys.cloudcell": {
    "source": "iana"
  },
  "application/vnd.flographit": {
    "source": "iana",
    "extensions": [
      "gph"
    ]
  },
  "application/vnd.fluxtime.clip": {
    "source": "iana",
    "extensions": [
      "ftc"
    ]
  },
  "application/vnd.font-fontforge-sfd": {
    "source": "iana"
  },
  "application/vnd.framemaker": {
    "source": "iana",
    "extensions": [
      "fm",
      "frame",
      "maker",
      "book"
    ]
  },
  "application/vnd.freelog.comic": {
    "source": "iana"
  },
  "application/vnd.frogans.fnc": {
    "source": "apache",
    "extensions": [
      "fnc"
    ]
  },
  "application/vnd.frogans.ltf": {
    "source": "apache",
    "extensions": [
      "ltf"
    ]
  },
  "application/vnd.fsc.weblaunch": {
    "source": "iana",
    "extensions": [
      "fsc"
    ]
  },
  "application/vnd.fujifilm.fb.docuworks": {
    "source": "iana"
  },
  "application/vnd.fujifilm.fb.docuworks.binder": {
    "source": "iana"
  },
  "application/vnd.fujifilm.fb.docuworks.container": {
    "source": "iana"
  },
  "application/vnd.fujifilm.fb.jfi+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.fujitsu.oasys": {
    "source": "iana",
    "extensions": [
      "oas"
    ]
  },
  "application/vnd.fujitsu.oasys2": {
    "source": "iana",
    "extensions": [
      "oa2"
    ]
  },
  "application/vnd.fujitsu.oasys3": {
    "source": "iana",
    "extensions": [
      "oa3"
    ]
  },
  "application/vnd.fujitsu.oasysgp": {
    "source": "iana",
    "extensions": [
      "fg5"
    ]
  },
  "application/vnd.fujitsu.oasysprs": {
    "source": "iana",
    "extensions": [
      "bh2"
    ]
  },
  "application/vnd.fujixerox.art-ex": {
    "source": "iana"
  },
  "application/vnd.fujixerox.art4": {
    "source": "iana"
  },
  "application/vnd.fujixerox.ddd": {
    "source": "iana",
    "extensions": [
      "ddd"
    ]
  },
  "application/vnd.fujixerox.docuworks": {
    "source": "iana",
    "extensions": [
      "xdw"
    ]
  },
  "application/vnd.fujixerox.docuworks.binder": {
    "source": "iana",
    "extensions": [
      "xbd"
    ]
  },
  "application/vnd.fujixerox.docuworks.container": {
    "source": "iana"
  },
  "application/vnd.fujixerox.hbpl": {
    "source": "iana"
  },
  "application/vnd.fut-misnet": {
    "source": "iana"
  },
  "application/vnd.futoin+cbor": {
    "source": "iana"
  },
  "application/vnd.futoin+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.fuzzysheet": {
    "source": "iana",
    "extensions": [
      "fzs"
    ]
  },
  "application/vnd.ga4gh.passport+jwt": {
    "source": "iana"
  },
  "application/vnd.genomatix.tuxedo": {
    "source": "iana",
    "extensions": [
      "txd"
    ]
  },
  "application/vnd.genozip": {
    "source": "iana"
  },
  "application/vnd.gentics.grd+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.gentoo.catmetadata+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.gentoo.ebuild": {
    "source": "iana"
  },
  "application/vnd.gentoo.eclass": {
    "source": "iana"
  },
  "application/vnd.gentoo.gpkg": {
    "source": "iana"
  },
  "application/vnd.gentoo.manifest": {
    "source": "iana"
  },
  "application/vnd.gentoo.pkgmetadata+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.gentoo.xpak": {
    "source": "iana"
  },
  "application/vnd.geo+json": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.geocube+xml": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.geogebra.file": {
    "source": "iana",
    "extensions": [
      "ggb"
    ]
  },
  "application/vnd.geogebra.slides": {
    "source": "iana",
    "extensions": [
      "ggs"
    ]
  },
  "application/vnd.geogebra.tool": {
    "source": "iana",
    "extensions": [
      "ggt"
    ]
  },
  "application/vnd.geometry-explorer": {
    "source": "iana",
    "extensions": [
      "gex",
      "gre"
    ]
  },
  "application/vnd.geonext": {
    "source": "iana",
    "extensions": [
      "gxt"
    ]
  },
  "application/vnd.geoplan": {
    "source": "iana",
    "extensions": [
      "g2w"
    ]
  },
  "application/vnd.geospace": {
    "source": "iana",
    "extensions": [
      "g3w"
    ]
  },
  "application/vnd.gerber": {
    "source": "iana"
  },
  "application/vnd.globalplatform.card-content-mgt": {
    "source": "iana"
  },
  "application/vnd.globalplatform.card-content-mgt-response": {
    "source": "iana"
  },
  "application/vnd.gmx": {
    "source": "iana",
    "extensions": [
      "gmx"
    ]
  },
  "application/vnd.gnu.taler.exchange+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.gnu.taler.merchant+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.google-apps.document": {
    "compressible": false,
    "extensions": [
      "gdoc"
    ]
  },
  "application/vnd.google-apps.presentation": {
    "compressible": false,
    "extensions": [
      "gslides"
    ]
  },
  "application/vnd.google-apps.spreadsheet": {
    "compressible": false,
    "extensions": [
      "gsheet"
    ]
  },
  "application/vnd.google-earth.kml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "kml"
    ]
  },
  "application/vnd.google-earth.kmz": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "kmz"
    ]
  },
  "application/vnd.gov.sk.e-form+xml": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.gov.sk.e-form+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.gov.sk.xmldatacontainer+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xdcf"
    ]
  },
  "application/vnd.gpxsee.map+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.grafeq": {
    "source": "iana",
    "extensions": [
      "gqf",
      "gqs"
    ]
  },
  "application/vnd.gridmp": {
    "source": "iana"
  },
  "application/vnd.groove-account": {
    "source": "iana",
    "extensions": [
      "gac"
    ]
  },
  "application/vnd.groove-help": {
    "source": "iana",
    "extensions": [
      "ghf"
    ]
  },
  "application/vnd.groove-identity-message": {
    "source": "iana",
    "extensions": [
      "gim"
    ]
  },
  "application/vnd.groove-injector": {
    "source": "iana",
    "extensions": [
      "grv"
    ]
  },
  "application/vnd.groove-tool-message": {
    "source": "iana",
    "extensions": [
      "gtm"
    ]
  },
  "application/vnd.groove-tool-template": {
    "source": "iana",
    "extensions": [
      "tpl"
    ]
  },
  "application/vnd.groove-vcard": {
    "source": "iana",
    "extensions": [
      "vcg"
    ]
  },
  "application/vnd.hal+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.hal+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "hal"
    ]
  },
  "application/vnd.handheld-entertainment+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "zmm"
    ]
  },
  "application/vnd.hbci": {
    "source": "iana",
    "extensions": [
      "hbci"
    ]
  },
  "application/vnd.hc+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.hcl-bireports": {
    "source": "iana"
  },
  "application/vnd.hdt": {
    "source": "iana"
  },
  "application/vnd.heroku+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.hhe.lesson-player": {
    "source": "iana",
    "extensions": [
      "les"
    ]
  },
  "application/vnd.hp-hpgl": {
    "source": "iana",
    "extensions": [
      "hpgl"
    ]
  },
  "application/vnd.hp-hpid": {
    "source": "iana",
    "extensions": [
      "hpid"
    ]
  },
  "application/vnd.hp-hps": {
    "source": "iana",
    "extensions": [
      "hps"
    ]
  },
  "application/vnd.hp-jlyt": {
    "source": "iana",
    "extensions": [
      "jlt"
    ]
  },
  "application/vnd.hp-pcl": {
    "source": "iana",
    "extensions": [
      "pcl"
    ]
  },
  "application/vnd.hp-pclxl": {
    "source": "iana",
    "extensions": [
      "pclxl"
    ]
  },
  "application/vnd.hsl": {
    "source": "iana"
  },
  "application/vnd.httphone": {
    "source": "iana"
  },
  "application/vnd.hydrostatix.sof-data": {
    "source": "iana",
    "extensions": [
      "sfd-hdstx"
    ]
  },
  "application/vnd.hyper+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.hyper-item+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.hyperdrive+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.hzn-3d-crossword": {
    "source": "iana"
  },
  "application/vnd.ibm.afplinedata": {
    "source": "apache"
  },
  "application/vnd.ibm.electronic-media": {
    "source": "iana"
  },
  "application/vnd.ibm.minipay": {
    "source": "iana",
    "extensions": [
      "mpy"
    ]
  },
  "application/vnd.ibm.modcap": {
    "source": "apache",
    "extensions": [
      "afp",
      "listafp",
      "list3820"
    ]
  },
  "application/vnd.ibm.rights-management": {
    "source": "iana",
    "extensions": [
      "irm"
    ]
  },
  "application/vnd.ibm.secure-container": {
    "source": "iana",
    "extensions": [
      "sc"
    ]
  },
  "application/vnd.iccprofile": {
    "source": "iana",
    "extensions": [
      "icc",
      "icm"
    ]
  },
  "application/vnd.ieee.1905": {
    "source": "iana"
  },
  "application/vnd.igloader": {
    "source": "iana",
    "extensions": [
      "igl"
    ]
  },
  "application/vnd.imagemeter.folder+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.imagemeter.image+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.immervision-ivp": {
    "source": "iana",
    "extensions": [
      "ivp"
    ]
  },
  "application/vnd.immervision-ivu": {
    "source": "iana",
    "extensions": [
      "ivu"
    ]
  },
  "application/vnd.ims.imsccv1p1": {
    "source": "iana"
  },
  "application/vnd.ims.imsccv1p2": {
    "source": "iana"
  },
  "application/vnd.ims.imsccv1p3": {
    "source": "iana"
  },
  "application/vnd.ims.lis.v2.result+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ims.lti.v2.toolconsumerprofile+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ims.lti.v2.toolproxy+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ims.lti.v2.toolproxy.id+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ims.lti.v2.toolsettings+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ims.lti.v2.toolsettings.simple+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.informedcontrol.rms+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.informix-visionary": {
    "source": "apache"
  },
  "application/vnd.infotech.project": {
    "source": "iana"
  },
  "application/vnd.infotech.project+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.innopath.wamp.notification": {
    "source": "iana"
  },
  "application/vnd.insors.igm": {
    "source": "iana",
    "extensions": [
      "igm"
    ]
  },
  "application/vnd.intercon.formnet": {
    "source": "iana",
    "extensions": [
      "xpw",
      "xpx"
    ]
  },
  "application/vnd.intergeo": {
    "source": "iana",
    "extensions": [
      "i2g"
    ]
  },
  "application/vnd.intertrust.digibox": {
    "source": "iana"
  },
  "application/vnd.intertrust.nncp": {
    "source": "iana"
  },
  "application/vnd.intu.qbo": {
    "source": "iana",
    "extensions": [
      "qbo"
    ]
  },
  "application/vnd.intu.qfx": {
    "source": "iana",
    "extensions": [
      "qfx"
    ]
  },
  "application/vnd.ipfs.ipns-record": {
    "source": "iana"
  },
  "application/vnd.ipld.car": {
    "source": "iana"
  },
  "application/vnd.ipld.dag-cbor": {
    "source": "iana"
  },
  "application/vnd.ipld.dag-json": {
    "source": "iana"
  },
  "application/vnd.ipld.raw": {
    "source": "iana"
  },
  "application/vnd.iptc.g2.catalogitem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.iptc.g2.conceptitem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.iptc.g2.knowledgeitem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.iptc.g2.newsitem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.iptc.g2.newsmessage+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.iptc.g2.packageitem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.iptc.g2.planningitem+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ipunplugged.rcprofile": {
    "source": "iana",
    "extensions": [
      "rcprofile"
    ]
  },
  "application/vnd.irepository.package+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "irp"
    ]
  },
  "application/vnd.is-xpr": {
    "source": "iana",
    "extensions": [
      "xpr"
    ]
  },
  "application/vnd.isac.fcs": {
    "source": "iana",
    "extensions": [
      "fcs"
    ]
  },
  "application/vnd.iso11783-10+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.jam": {
    "source": "iana",
    "extensions": [
      "jam"
    ]
  },
  "application/vnd.japannet-directory-service": {
    "source": "iana"
  },
  "application/vnd.japannet-jpnstore-wakeup": {
    "source": "iana"
  },
  "application/vnd.japannet-payment-wakeup": {
    "source": "iana"
  },
  "application/vnd.japannet-registration": {
    "source": "iana"
  },
  "application/vnd.japannet-registration-wakeup": {
    "source": "iana"
  },
  "application/vnd.japannet-setstore-wakeup": {
    "source": "iana"
  },
  "application/vnd.japannet-verification": {
    "source": "iana"
  },
  "application/vnd.japannet-verification-wakeup": {
    "source": "iana"
  },
  "application/vnd.jcp.javame.midlet-rms": {
    "source": "iana",
    "extensions": [
      "rms"
    ]
  },
  "application/vnd.jisp": {
    "source": "iana",
    "extensions": [
      "jisp"
    ]
  },
  "application/vnd.joost.joda-archive": {
    "source": "iana",
    "extensions": [
      "joda"
    ]
  },
  "application/vnd.jsk.isdn-ngn": {
    "source": "iana"
  },
  "application/vnd.kahootz": {
    "source": "iana",
    "extensions": [
      "ktz",
      "ktr"
    ]
  },
  "application/vnd.kde.karbon": {
    "source": "iana",
    "extensions": [
      "karbon"
    ]
  },
  "application/vnd.kde.kchart": {
    "source": "iana",
    "extensions": [
      "chrt"
    ]
  },
  "application/vnd.kde.kformula": {
    "source": "iana",
    "extensions": [
      "kfo"
    ]
  },
  "application/vnd.kde.kivio": {
    "source": "iana",
    "extensions": [
      "flw"
    ]
  },
  "application/vnd.kde.kontour": {
    "source": "iana",
    "extensions": [
      "kon"
    ]
  },
  "application/vnd.kde.kpresenter": {
    "source": "iana",
    "extensions": [
      "kpr",
      "kpt"
    ]
  },
  "application/vnd.kde.kspread": {
    "source": "iana",
    "extensions": [
      "ksp"
    ]
  },
  "application/vnd.kde.kword": {
    "source": "iana",
    "extensions": [
      "kwd",
      "kwt"
    ]
  },
  "application/vnd.kenameaapp": {
    "source": "iana",
    "extensions": [
      "htke"
    ]
  },
  "application/vnd.kidspiration": {
    "source": "iana",
    "extensions": [
      "kia"
    ]
  },
  "application/vnd.kinar": {
    "source": "iana",
    "extensions": [
      "kne",
      "knp"
    ]
  },
  "application/vnd.koan": {
    "source": "iana",
    "extensions": [
      "skp",
      "skd",
      "skt",
      "skm"
    ]
  },
  "application/vnd.kodak-descriptor": {
    "source": "iana",
    "extensions": [
      "sse"
    ]
  },
  "application/vnd.las": {
    "source": "iana"
  },
  "application/vnd.las.las+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.las.las+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "lasxml"
    ]
  },
  "application/vnd.laszip": {
    "source": "iana"
  },
  "application/vnd.ldev.productlicensing": {
    "source": "iana"
  },
  "application/vnd.leap+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.liberty-request+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.llamagraphics.life-balance.desktop": {
    "source": "iana",
    "extensions": [
      "lbd"
    ]
  },
  "application/vnd.llamagraphics.life-balance.exchange+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "lbe"
    ]
  },
  "application/vnd.logipipe.circuit+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.loom": {
    "source": "iana"
  },
  "application/vnd.lotus-1-2-3": {
    "source": "iana",
    "extensions": [
      "123"
    ]
  },
  "application/vnd.lotus-approach": {
    "source": "iana",
    "extensions": [
      "apr"
    ]
  },
  "application/vnd.lotus-freelance": {
    "source": "iana",
    "extensions": [
      "pre"
    ]
  },
  "application/vnd.lotus-notes": {
    "source": "iana",
    "extensions": [
      "nsf"
    ]
  },
  "application/vnd.lotus-organizer": {
    "source": "iana",
    "extensions": [
      "org"
    ]
  },
  "application/vnd.lotus-screencam": {
    "source": "iana",
    "extensions": [
      "scm"
    ]
  },
  "application/vnd.lotus-wordpro": {
    "source": "iana",
    "extensions": [
      "lwp"
    ]
  },
  "application/vnd.macports.portpkg": {
    "source": "iana",
    "extensions": [
      "portpkg"
    ]
  },
  "application/vnd.mapbox-vector-tile": {
    "source": "iana",
    "extensions": [
      "mvt"
    ]
  },
  "application/vnd.marlin.drm.actiontoken+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.marlin.drm.conftoken+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.marlin.drm.license+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.marlin.drm.mdcf": {
    "source": "iana"
  },
  "application/vnd.mason+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.maxar.archive.3tz+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.maxmind.maxmind-db": {
    "source": "iana"
  },
  "application/vnd.mcd": {
    "source": "iana",
    "extensions": [
      "mcd"
    ]
  },
  "application/vnd.mdl": {
    "source": "iana"
  },
  "application/vnd.mdl-mbsdf": {
    "source": "iana"
  },
  "application/vnd.medcalcdata": {
    "source": "iana",
    "extensions": [
      "mc1"
    ]
  },
  "application/vnd.mediastation.cdkey": {
    "source": "iana",
    "extensions": [
      "cdkey"
    ]
  },
  "application/vnd.medicalholodeck.recordxr": {
    "source": "iana"
  },
  "application/vnd.meridian-slingshot": {
    "source": "iana"
  },
  "application/vnd.mermaid": {
    "source": "iana"
  },
  "application/vnd.mfer": {
    "source": "iana",
    "extensions": [
      "mwf"
    ]
  },
  "application/vnd.mfmp": {
    "source": "iana",
    "extensions": [
      "mfm"
    ]
  },
  "application/vnd.micro+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.micrografx.flo": {
    "source": "iana",
    "extensions": [
      "flo"
    ]
  },
  "application/vnd.micrografx.igx": {
    "source": "iana",
    "extensions": [
      "igx"
    ]
  },
  "application/vnd.microsoft.portable-executable": {
    "source": "iana"
  },
  "application/vnd.microsoft.windows.thumbnail-cache": {
    "source": "iana"
  },
  "application/vnd.miele+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.mif": {
    "source": "iana",
    "extensions": [
      "mif"
    ]
  },
  "application/vnd.minisoft-hp3000-save": {
    "source": "iana"
  },
  "application/vnd.mitsubishi.misty-guard.trustweb": {
    "source": "iana"
  },
  "application/vnd.mobius.daf": {
    "source": "iana",
    "extensions": [
      "daf"
    ]
  },
  "application/vnd.mobius.dis": {
    "source": "iana",
    "extensions": [
      "dis"
    ]
  },
  "application/vnd.mobius.mbk": {
    "source": "iana",
    "extensions": [
      "mbk"
    ]
  },
  "application/vnd.mobius.mqy": {
    "source": "iana",
    "extensions": [
      "mqy"
    ]
  },
  "application/vnd.mobius.msl": {
    "source": "iana",
    "extensions": [
      "msl"
    ]
  },
  "application/vnd.mobius.plc": {
    "source": "iana",
    "extensions": [
      "plc"
    ]
  },
  "application/vnd.mobius.txf": {
    "source": "iana",
    "extensions": [
      "txf"
    ]
  },
  "application/vnd.modl": {
    "source": "iana"
  },
  "application/vnd.mophun.application": {
    "source": "iana",
    "extensions": [
      "mpn"
    ]
  },
  "application/vnd.mophun.certificate": {
    "source": "iana",
    "extensions": [
      "mpc"
    ]
  },
  "application/vnd.motorola.flexsuite": {
    "source": "iana"
  },
  "application/vnd.motorola.flexsuite.adsi": {
    "source": "iana"
  },
  "application/vnd.motorola.flexsuite.fis": {
    "source": "iana"
  },
  "application/vnd.motorola.flexsuite.gotap": {
    "source": "iana"
  },
  "application/vnd.motorola.flexsuite.kmr": {
    "source": "iana"
  },
  "application/vnd.motorola.flexsuite.ttc": {
    "source": "iana"
  },
  "application/vnd.motorola.flexsuite.wem": {
    "source": "iana"
  },
  "application/vnd.motorola.iprm": {
    "source": "iana"
  },
  "application/vnd.mozilla.xul+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xul"
    ]
  },
  "application/vnd.ms-3mfdocument": {
    "source": "iana"
  },
  "application/vnd.ms-artgalry": {
    "source": "iana",
    "extensions": [
      "cil"
    ]
  },
  "application/vnd.ms-asf": {
    "source": "iana"
  },
  "application/vnd.ms-cab-compressed": {
    "source": "iana",
    "extensions": [
      "cab"
    ]
  },
  "application/vnd.ms-color.iccprofile": {
    "source": "apache"
  },
  "application/vnd.ms-excel": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "xls",
      "xlm",
      "xla",
      "xlc",
      "xlt",
      "xlw"
    ]
  },
  "application/vnd.ms-excel.addin.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "xlam"
    ]
  },
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "xlsb"
    ]
  },
  "application/vnd.ms-excel.sheet.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "xlsm"
    ]
  },
  "application/vnd.ms-excel.template.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "xltm"
    ]
  },
  "application/vnd.ms-fontobject": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "eot"
    ]
  },
  "application/vnd.ms-htmlhelp": {
    "source": "iana",
    "extensions": [
      "chm"
    ]
  },
  "application/vnd.ms-ims": {
    "source": "iana",
    "extensions": [
      "ims"
    ]
  },
  "application/vnd.ms-lrm": {
    "source": "iana",
    "extensions": [
      "lrm"
    ]
  },
  "application/vnd.ms-office.activex+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ms-officetheme": {
    "source": "iana",
    "extensions": [
      "thmx"
    ]
  },
  "application/vnd.ms-opentype": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.ms-outlook": {
    "compressible": false,
    "extensions": [
      "msg"
    ]
  },
  "application/vnd.ms-package.obfuscated-opentype": {
    "source": "apache"
  },
  "application/vnd.ms-pki.seccat": {
    "source": "apache",
    "extensions": [
      "cat"
    ]
  },
  "application/vnd.ms-pki.stl": {
    "source": "apache",
    "extensions": [
      "stl"
    ]
  },
  "application/vnd.ms-playready.initiator+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ms-powerpoint": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "ppt",
      "pps",
      "pot"
    ]
  },
  "application/vnd.ms-powerpoint.addin.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "ppam"
    ]
  },
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "pptm"
    ]
  },
  "application/vnd.ms-powerpoint.slide.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "sldm"
    ]
  },
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "ppsm"
    ]
  },
  "application/vnd.ms-powerpoint.template.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "potm"
    ]
  },
  "application/vnd.ms-printdevicecapabilities+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ms-printing.printticket+xml": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.ms-printschematicket+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.ms-project": {
    "source": "iana",
    "extensions": [
      "mpp",
      "mpt"
    ]
  },
  "application/vnd.ms-tnef": {
    "source": "iana"
  },
  "application/vnd.ms-windows.devicepairing": {
    "source": "iana"
  },
  "application/vnd.ms-windows.nwprinting.oob": {
    "source": "iana"
  },
  "application/vnd.ms-windows.printerpairing": {
    "source": "iana"
  },
  "application/vnd.ms-windows.wsd.oob": {
    "source": "iana"
  },
  "application/vnd.ms-wmdrm.lic-chlg-req": {
    "source": "iana"
  },
  "application/vnd.ms-wmdrm.lic-resp": {
    "source": "iana"
  },
  "application/vnd.ms-wmdrm.meter-chlg-req": {
    "source": "iana"
  },
  "application/vnd.ms-wmdrm.meter-resp": {
    "source": "iana"
  },
  "application/vnd.ms-word.document.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "docm"
    ]
  },
  "application/vnd.ms-word.template.macroenabled.12": {
    "source": "iana",
    "extensions": [
      "dotm"
    ]
  },
  "application/vnd.ms-works": {
    "source": "iana",
    "extensions": [
      "wps",
      "wks",
      "wcm",
      "wdb"
    ]
  },
  "application/vnd.ms-wpl": {
    "source": "iana",
    "extensions": [
      "wpl"
    ]
  },
  "application/vnd.ms-xpsdocument": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "xps"
    ]
  },
  "application/vnd.msa-disk-image": {
    "source": "iana"
  },
  "application/vnd.mseq": {
    "source": "iana",
    "extensions": [
      "mseq"
    ]
  },
  "application/vnd.msgpack": {
    "source": "iana"
  },
  "application/vnd.msign": {
    "source": "iana"
  },
  "application/vnd.multiad.creator": {
    "source": "iana"
  },
  "application/vnd.multiad.creator.cif": {
    "source": "iana"
  },
  "application/vnd.music-niff": {
    "source": "iana"
  },
  "application/vnd.musician": {
    "source": "iana",
    "extensions": [
      "mus"
    ]
  },
  "application/vnd.muvee.style": {
    "source": "iana",
    "extensions": [
      "msty"
    ]
  },
  "application/vnd.mynfc": {
    "source": "iana",
    "extensions": [
      "taglet"
    ]
  },
  "application/vnd.nacamar.ybrid+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nato.bindingdataobject+cbor": {
    "source": "iana"
  },
  "application/vnd.nato.bindingdataobject+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nato.bindingdataobject+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "bdo"
    ]
  },
  "application/vnd.nato.openxmlformats-package.iepd+zip": {
    "source": "iana",
    "compressible": false
  },
  "application/vnd.ncd.control": {
    "source": "iana"
  },
  "application/vnd.ncd.reference": {
    "source": "iana"
  },
  "application/vnd.nearst.inv+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nebumind.line": {
    "source": "iana"
  },
  "application/vnd.nervana": {
    "source": "iana"
  },
  "application/vnd.netfpx": {
    "source": "iana"
  },
  "application/vnd.neurolanguage.nlu": {
    "source": "iana",
    "extensions": [
      "nlu"
    ]
  },
  "application/vnd.nimn": {
    "source": "iana"
  },
  "application/vnd.nintendo.nitro.rom": {
    "source": "iana"
  },
  "application/vnd.nintendo.snes.rom": {
    "source": "iana"
  },
  "application/vnd.nitf": {
    "source": "iana",
    "extensions": [
      "ntf",
      "nitf"
    ]
  },
  "application/vnd.noblenet-directory": {
    "source": "iana",
    "extensions": [
      "nnd"
    ]
  },
  "application/vnd.noblenet-sealer": {
    "source": "iana",
    "extensions": [
      "nns"
    ]
  },
  "application/vnd.noblenet-web": {
    "source": "iana",
    "extensions": [
      "nnw"
    ]
  },
  "application/vnd.nokia.catalogs": {
    "source": "iana"
  },
  "application/vnd.nokia.conml+wbxml": {
    "source": "iana"
  },
  "application/vnd.nokia.conml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nokia.iptv.config+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nokia.isds-radio-presets": {
    "source": "iana"
  },
  "application/vnd.nokia.landmark+wbxml": {
    "source": "iana"
  },
  "application/vnd.nokia.landmark+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nokia.landmarkcollection+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nokia.n-gage.ac+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ac"
    ]
  },
  "application/vnd.nokia.n-gage.data": {
    "source": "iana",
    "extensions": [
      "ngdat"
    ]
  },
  "application/vnd.nokia.n-gage.symbian.install": {
    "source": "apache",
    "extensions": [
      "n-gage"
    ]
  },
  "application/vnd.nokia.ncd": {
    "source": "iana"
  },
  "application/vnd.nokia.pcd+wbxml": {
    "source": "iana"
  },
  "application/vnd.nokia.pcd+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.nokia.radio-preset": {
    "source": "iana",
    "extensions": [
      "rpst"
    ]
  },
  "application/vnd.nokia.radio-presets": {
    "source": "iana",
    "extensions": [
      "rpss"
    ]
  },
  "application/vnd.novadigm.edm": {
    "source": "iana",
    "extensions": [
      "edm"
    ]
  },
  "application/vnd.novadigm.edx": {
    "source": "iana",
    "extensions": [
      "edx"
    ]
  },
  "application/vnd.novadigm.ext": {
    "source": "iana",
    "extensions": [
      "ext"
    ]
  },
  "application/vnd.ntt-local.content-share": {
    "source": "iana"
  },
  "application/vnd.ntt-local.file-transfer": {
    "source": "iana"
  },
  "application/vnd.ntt-local.ogw_remote-access": {
    "source": "iana"
  },
  "application/vnd.ntt-local.sip-ta_remote": {
    "source": "iana"
  },
  "application/vnd.ntt-local.sip-ta_tcp_stream": {
    "source": "iana"
  },
  "application/vnd.oai.workflows": {
    "source": "iana"
  },
  "application/vnd.oai.workflows+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oai.workflows+yaml": {
    "source": "iana"
  },
  "application/vnd.oasis.opendocument.base": {
    "source": "iana"
  },
  "application/vnd.oasis.opendocument.chart": {
    "source": "iana",
    "extensions": [
      "odc"
    ]
  },
  "application/vnd.oasis.opendocument.chart-template": {
    "source": "iana",
    "extensions": [
      "otc"
    ]
  },
  "application/vnd.oasis.opendocument.database": {
    "source": "apache",
    "extensions": [
      "odb"
    ]
  },
  "application/vnd.oasis.opendocument.formula": {
    "source": "iana",
    "extensions": [
      "odf"
    ]
  },
  "application/vnd.oasis.opendocument.formula-template": {
    "source": "iana",
    "extensions": [
      "odft"
    ]
  },
  "application/vnd.oasis.opendocument.graphics": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "odg"
    ]
  },
  "application/vnd.oasis.opendocument.graphics-template": {
    "source": "iana",
    "extensions": [
      "otg"
    ]
  },
  "application/vnd.oasis.opendocument.image": {
    "source": "iana",
    "extensions": [
      "odi"
    ]
  },
  "application/vnd.oasis.opendocument.image-template": {
    "source": "iana",
    "extensions": [
      "oti"
    ]
  },
  "application/vnd.oasis.opendocument.presentation": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "odp"
    ]
  },
  "application/vnd.oasis.opendocument.presentation-template": {
    "source": "iana",
    "extensions": [
      "otp"
    ]
  },
  "application/vnd.oasis.opendocument.spreadsheet": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "ods"
    ]
  },
  "application/vnd.oasis.opendocument.spreadsheet-template": {
    "source": "iana",
    "extensions": [
      "ots"
    ]
  },
  "application/vnd.oasis.opendocument.text": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "odt"
    ]
  },
  "application/vnd.oasis.opendocument.text-master": {
    "source": "iana",
    "extensions": [
      "odm"
    ]
  },
  "application/vnd.oasis.opendocument.text-master-template": {
    "source": "iana"
  },
  "application/vnd.oasis.opendocument.text-template": {
    "source": "iana",
    "extensions": [
      "ott"
    ]
  },
  "application/vnd.oasis.opendocument.text-web": {
    "source": "iana",
    "extensions": [
      "oth"
    ]
  },
  "application/vnd.obn": {
    "source": "iana"
  },
  "application/vnd.ocf+cbor": {
    "source": "iana"
  },
  "application/vnd.oci.image.manifest.v1+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oftn.l10n+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.contentaccessdownload+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.contentaccessstreaming+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.cspg-hexbinary": {
    "source": "iana"
  },
  "application/vnd.oipf.dae.svg+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.dae.xhtml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.mippvcontrolmessage+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.pae.gem": {
    "source": "iana"
  },
  "application/vnd.oipf.spdiscovery+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.spdlist+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.ueprofile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oipf.userprofile+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.olpc-sugar": {
    "source": "iana",
    "extensions": [
      "xo"
    ]
  },
  "application/vnd.oma-scws-config": {
    "source": "iana"
  },
  "application/vnd.oma-scws-http-request": {
    "source": "iana"
  },
  "application/vnd.oma-scws-http-response": {
    "source": "iana"
  },
  "application/vnd.oma.bcast.associated-procedure-parameter+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.bcast.drm-trigger+xml": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.oma.bcast.imd+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.bcast.ltkm": {
    "source": "iana"
  },
  "application/vnd.oma.bcast.notification+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.bcast.provisioningtrigger": {
    "source": "iana"
  },
  "application/vnd.oma.bcast.sgboot": {
    "source": "iana"
  },
  "application/vnd.oma.bcast.sgdd+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.bcast.sgdu": {
    "source": "iana"
  },
  "application/vnd.oma.bcast.simple-symbol-container": {
    "source": "iana"
  },
  "application/vnd.oma.bcast.smartcard-trigger+xml": {
    "source": "apache",
    "compressible": true
  },
  "application/vnd.oma.bcast.sprov+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.bcast.stkm": {
    "source": "iana"
  },
  "application/vnd.oma.cab-address-book+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.cab-feature-handler+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.cab-pcc+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.cab-subs-invite+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.cab-user-prefs+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.dcd": {
    "source": "iana"
  },
  "application/vnd.oma.dcdc": {
    "source": "iana"
  },
  "application/vnd.oma.dd2+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "dd2"
    ]
  },
  "application/vnd.oma.drm.risd+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.group-usage-list+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.lwm2m+cbor": {
    "source": "iana"
  },
  "application/vnd.oma.lwm2m+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.lwm2m+tlv": {
    "source": "iana"
  },
  "application/vnd.oma.pal+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.poc.detailed-progress-report+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.poc.final-report+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.poc.groups+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.poc.invocation-descriptor+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.poc.optimized-progress-report+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.push": {
    "source": "iana"
  },
  "application/vnd.oma.scidm.messages+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oma.xcap-directory+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.omads-email+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/vnd.omads-file+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/vnd.omads-folder+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/vnd.omaloc-supl-init": {
    "source": "iana"
  },
  "application/vnd.onepager": {
    "source": "iana"
  },
  "application/vnd.onepagertamp": {
    "source": "iana"
  },
  "application/vnd.onepagertamx": {
    "source": "iana"
  },
  "application/vnd.onepagertat": {
    "source": "iana"
  },
  "application/vnd.onepagertatp": {
    "source": "iana"
  },
  "application/vnd.onepagertatx": {
    "source": "iana"
  },
  "application/vnd.onvif.metadata": {
    "source": "iana"
  },
  "application/vnd.openblox.game+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "obgx"
    ]
  },
  "application/vnd.openblox.game-binary": {
    "source": "iana"
  },
  "application/vnd.openeye.oeb": {
    "source": "iana"
  },
  "application/vnd.openofficeorg.extension": {
    "source": "apache",
    "extensions": [
      "oxt"
    ]
  },
  "application/vnd.openstreetmap.data+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "osm"
    ]
  },
  "application/vnd.opentimestamps.ots": {
    "source": "iana"
  },
  "application/vnd.openxmlformats-officedocument.custom-properties+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.customxmlproperties+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawing+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawingml.chart+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramcolors+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramdata+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramlayout+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramstyle+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.extended-properties+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.commentauthors+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.comments+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.handoutmaster+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.notesmaster+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.notesslide+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "pptx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presprops+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slide": {
    "source": "iana",
    "extensions": [
      "sldx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slidelayout+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slidemaster+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": {
    "source": "iana",
    "extensions": [
      "ppsx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.slideupdateinfo+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.tablestyles+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.tags+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.template": {
    "source": "iana",
    "extensions": [
      "potx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.presentationml.viewprops+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.calcchain+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.externallink+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcachedefinition+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcacherecords+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivottable+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.querytable+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionheaders+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionlog+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedstrings+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "xlsx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetmetadata+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.tablesinglecells+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template": {
    "source": "iana",
    "extensions": [
      "xltx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.usernames+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.volatiledependencies+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.theme+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.themeoverride+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.vmldrawing": {
    "source": "iana"
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "docx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.fonttable+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": {
    "source": "iana",
    "extensions": [
      "dotx"
    ]
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.websettings+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-package.core-properties+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.openxmlformats-package.relationships+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oracle.resource+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.orange.indata": {
    "source": "iana"
  },
  "application/vnd.osa.netdeploy": {
    "source": "iana"
  },
  "application/vnd.osgeo.mapguide.package": {
    "source": "iana",
    "extensions": [
      "mgp"
    ]
  },
  "application/vnd.osgi.bundle": {
    "source": "iana"
  },
  "application/vnd.osgi.dp": {
    "source": "iana",
    "extensions": [
      "dp"
    ]
  },
  "application/vnd.osgi.subsystem": {
    "source": "iana",
    "extensions": [
      "esa"
    ]
  },
  "application/vnd.otps.ct-kip+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.oxli.countgraph": {
    "source": "iana"
  },
  "application/vnd.pagerduty+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.palm": {
    "source": "iana",
    "extensions": [
      "pdb",
      "pqa",
      "oprc"
    ]
  },
  "application/vnd.panoply": {
    "source": "iana"
  },
  "application/vnd.paos.xml": {
    "source": "iana"
  },
  "application/vnd.patentdive": {
    "source": "iana"
  },
  "application/vnd.patientecommsdoc": {
    "source": "iana"
  },
  "application/vnd.pawaafile": {
    "source": "iana",
    "extensions": [
      "paw"
    ]
  },
  "application/vnd.pcos": {
    "source": "iana"
  },
  "application/vnd.pg.format": {
    "source": "iana",
    "extensions": [
      "str"
    ]
  },
  "application/vnd.pg.osasli": {
    "source": "iana",
    "extensions": [
      "ei6"
    ]
  },
  "application/vnd.piaccess.application-licence": {
    "source": "iana"
  },
  "application/vnd.picsel": {
    "source": "iana",
    "extensions": [
      "efif"
    ]
  },
  "application/vnd.pmi.widget": {
    "source": "iana",
    "extensions": [
      "wg"
    ]
  },
  "application/vnd.poc.group-advertisement+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.pocketlearn": {
    "source": "iana",
    "extensions": [
      "plf"
    ]
  },
  "application/vnd.powerbuilder6": {
    "source": "iana",
    "extensions": [
      "pbd"
    ]
  },
  "application/vnd.powerbuilder6-s": {
    "source": "iana"
  },
  "application/vnd.powerbuilder7": {
    "source": "iana"
  },
  "application/vnd.powerbuilder7-s": {
    "source": "iana"
  },
  "application/vnd.powerbuilder75": {
    "source": "iana"
  },
  "application/vnd.powerbuilder75-s": {
    "source": "iana"
  },
  "application/vnd.preminet": {
    "source": "iana"
  },
  "application/vnd.previewsystems.box": {
    "source": "iana",
    "extensions": [
      "box"
    ]
  },
  "application/vnd.proteus.magazine": {
    "source": "iana",
    "extensions": [
      "mgz"
    ]
  },
  "application/vnd.psfs": {
    "source": "iana"
  },
  "application/vnd.pt.mundusmundi": {
    "source": "iana"
  },
  "application/vnd.publishare-delta-tree": {
    "source": "iana",
    "extensions": [
      "qps"
    ]
  },
  "application/vnd.pvi.ptid1": {
    "source": "iana",
    "extensions": [
      "ptid"
    ]
  },
  "application/vnd.pwg-multiplexed": {
    "source": "iana"
  },
  "application/vnd.pwg-xhtml-print+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xhtm"
    ]
  },
  "application/vnd.qualcomm.brew-app-res": {
    "source": "iana"
  },
  "application/vnd.quarantainenet": {
    "source": "iana"
  },
  "application/vnd.quark.quarkxpress": {
    "source": "iana",
    "extensions": [
      "qxd",
      "qxt",
      "qwd",
      "qwt",
      "qxl",
      "qxb"
    ]
  },
  "application/vnd.quobject-quoxdocument": {
    "source": "iana"
  },
  "application/vnd.radisys.moml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-audit+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-audit-conf+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-audit-conn+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-audit-dialog+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-audit-stream+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-conf+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog-base+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog-fax-detect+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog-fax-sendrecv+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog-group+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog-speech+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.radisys.msml-dialog-transform+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.rainstor.data": {
    "source": "iana"
  },
  "application/vnd.rapid": {
    "source": "iana"
  },
  "application/vnd.rar": {
    "source": "iana",
    "extensions": [
      "rar"
    ]
  },
  "application/vnd.realvnc.bed": {
    "source": "iana",
    "extensions": [
      "bed"
    ]
  },
  "application/vnd.recordare.musicxml": {
    "source": "iana",
    "extensions": [
      "mxl"
    ]
  },
  "application/vnd.recordare.musicxml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "musicxml"
    ]
  },
  "application/vnd.relpipe": {
    "source": "iana"
  },
  "application/vnd.renlearn.rlprint": {
    "source": "iana"
  },
  "application/vnd.resilient.logic": {
    "source": "iana"
  },
  "application/vnd.restful+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.rig.cryptonote": {
    "source": "iana",
    "extensions": [
      "cryptonote"
    ]
  },
  "application/vnd.rim.cod": {
    "source": "apache",
    "extensions": [
      "cod"
    ]
  },
  "application/vnd.rn-realmedia": {
    "source": "apache",
    "extensions": [
      "rm"
    ]
  },
  "application/vnd.rn-realmedia-vbr": {
    "source": "apache",
    "extensions": [
      "rmvb"
    ]
  },
  "application/vnd.route66.link66+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "link66"
    ]
  },
  "application/vnd.rs-274x": {
    "source": "iana"
  },
  "application/vnd.ruckus.download": {
    "source": "iana"
  },
  "application/vnd.s3sms": {
    "source": "iana"
  },
  "application/vnd.sailingtracker.track": {
    "source": "iana",
    "extensions": [
      "st"
    ]
  },
  "application/vnd.sar": {
    "source": "iana"
  },
  "application/vnd.sbm.cid": {
    "source": "iana"
  },
  "application/vnd.sbm.mid2": {
    "source": "iana"
  },
  "application/vnd.scribus": {
    "source": "iana"
  },
  "application/vnd.sealed.3df": {
    "source": "iana"
  },
  "application/vnd.sealed.csf": {
    "source": "iana"
  },
  "application/vnd.sealed.doc": {
    "source": "iana"
  },
  "application/vnd.sealed.eml": {
    "source": "iana"
  },
  "application/vnd.sealed.mht": {
    "source": "iana"
  },
  "application/vnd.sealed.net": {
    "source": "iana"
  },
  "application/vnd.sealed.ppt": {
    "source": "iana"
  },
  "application/vnd.sealed.tiff": {
    "source": "iana"
  },
  "application/vnd.sealed.xls": {
    "source": "iana"
  },
  "application/vnd.sealedmedia.softseal.html": {
    "source": "iana"
  },
  "application/vnd.sealedmedia.softseal.pdf": {
    "source": "iana"
  },
  "application/vnd.seemail": {
    "source": "iana",
    "extensions": [
      "see"
    ]
  },
  "application/vnd.seis+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.sema": {
    "source": "iana",
    "extensions": [
      "sema"
    ]
  },
  "application/vnd.semd": {
    "source": "iana",
    "extensions": [
      "semd"
    ]
  },
  "application/vnd.semf": {
    "source": "iana",
    "extensions": [
      "semf"
    ]
  },
  "application/vnd.shade-save-file": {
    "source": "iana"
  },
  "application/vnd.shana.informed.formdata": {
    "source": "iana",
    "extensions": [
      "ifm"
    ]
  },
  "application/vnd.shana.informed.formtemplate": {
    "source": "iana",
    "extensions": [
      "itp"
    ]
  },
  "application/vnd.shana.informed.interchange": {
    "source": "iana",
    "extensions": [
      "iif"
    ]
  },
  "application/vnd.shana.informed.package": {
    "source": "iana",
    "extensions": [
      "ipk"
    ]
  },
  "application/vnd.shootproof+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.shopkick+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.shp": {
    "source": "iana"
  },
  "application/vnd.shx": {
    "source": "iana"
  },
  "application/vnd.sigrok.session": {
    "source": "iana"
  },
  "application/vnd.simtech-mindmapper": {
    "source": "iana",
    "extensions": [
      "twd",
      "twds"
    ]
  },
  "application/vnd.siren+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.smaf": {
    "source": "iana",
    "extensions": [
      "mmf"
    ]
  },
  "application/vnd.smart.notebook": {
    "source": "iana"
  },
  "application/vnd.smart.teacher": {
    "source": "iana",
    "extensions": [
      "teacher"
    ]
  },
  "application/vnd.smintio.portals.archive": {
    "source": "iana"
  },
  "application/vnd.snesdev-page-table": {
    "source": "iana"
  },
  "application/vnd.software602.filler.form+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "fo"
    ]
  },
  "application/vnd.software602.filler.form-xml-zip": {
    "source": "iana"
  },
  "application/vnd.solent.sdkm+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "sdkm",
      "sdkd"
    ]
  },
  "application/vnd.spotfire.dxp": {
    "source": "iana",
    "extensions": [
      "dxp"
    ]
  },
  "application/vnd.spotfire.sfs": {
    "source": "iana",
    "extensions": [
      "sfs"
    ]
  },
  "application/vnd.sqlite3": {
    "source": "iana"
  },
  "application/vnd.sss-cod": {
    "source": "iana"
  },
  "application/vnd.sss-dtf": {
    "source": "iana"
  },
  "application/vnd.sss-ntf": {
    "source": "iana"
  },
  "application/vnd.stardivision.calc": {
    "source": "apache",
    "extensions": [
      "sdc"
    ]
  },
  "application/vnd.stardivision.draw": {
    "source": "apache",
    "extensions": [
      "sda"
    ]
  },
  "application/vnd.stardivision.impress": {
    "source": "apache",
    "extensions": [
      "sdd"
    ]
  },
  "application/vnd.stardivision.math": {
    "source": "apache",
    "extensions": [
      "smf"
    ]
  },
  "application/vnd.stardivision.writer": {
    "source": "apache",
    "extensions": [
      "sdw",
      "vor"
    ]
  },
  "application/vnd.stardivision.writer-global": {
    "source": "apache",
    "extensions": [
      "sgl"
    ]
  },
  "application/vnd.stepmania.package": {
    "source": "iana",
    "extensions": [
      "smzip"
    ]
  },
  "application/vnd.stepmania.stepchart": {
    "source": "iana",
    "extensions": [
      "sm"
    ]
  },
  "application/vnd.street-stream": {
    "source": "iana"
  },
  "application/vnd.sun.wadl+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "wadl"
    ]
  },
  "application/vnd.sun.xml.calc": {
    "source": "apache",
    "extensions": [
      "sxc"
    ]
  },
  "application/vnd.sun.xml.calc.template": {
    "source": "apache",
    "extensions": [
      "stc"
    ]
  },
  "application/vnd.sun.xml.draw": {
    "source": "apache",
    "extensions": [
      "sxd"
    ]
  },
  "application/vnd.sun.xml.draw.template": {
    "source": "apache",
    "extensions": [
      "std"
    ]
  },
  "application/vnd.sun.xml.impress": {
    "source": "apache",
    "extensions": [
      "sxi"
    ]
  },
  "application/vnd.sun.xml.impress.template": {
    "source": "apache",
    "extensions": [
      "sti"
    ]
  },
  "application/vnd.sun.xml.math": {
    "source": "apache",
    "extensions": [
      "sxm"
    ]
  },
  "application/vnd.sun.xml.writer": {
    "source": "apache",
    "extensions": [
      "sxw"
    ]
  },
  "application/vnd.sun.xml.writer.global": {
    "source": "apache",
    "extensions": [
      "sxg"
    ]
  },
  "application/vnd.sun.xml.writer.template": {
    "source": "apache",
    "extensions": [
      "stw"
    ]
  },
  "application/vnd.sus-calendar": {
    "source": "iana",
    "extensions": [
      "sus",
      "susp"
    ]
  },
  "application/vnd.svd": {
    "source": "iana",
    "extensions": [
      "svd"
    ]
  },
  "application/vnd.swiftview-ics": {
    "source": "iana"
  },
  "application/vnd.sybyl.mol2": {
    "source": "iana"
  },
  "application/vnd.sycle+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.syft+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.symbian.install": {
    "source": "apache",
    "extensions": [
      "sis",
      "sisx"
    ]
  },
  "application/vnd.syncml+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "xsm"
    ]
  },
  "application/vnd.syncml.dm+wbxml": {
    "source": "iana",
    "charset": "UTF-8",
    "extensions": [
      "bdm"
    ]
  },
  "application/vnd.syncml.dm+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "xdm"
    ]
  },
  "application/vnd.syncml.dm.notification": {
    "source": "iana"
  },
  "application/vnd.syncml.dmddf+wbxml": {
    "source": "iana"
  },
  "application/vnd.syncml.dmddf+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "ddf"
    ]
  },
  "application/vnd.syncml.dmtnds+wbxml": {
    "source": "iana"
  },
  "application/vnd.syncml.dmtnds+xml": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true
  },
  "application/vnd.syncml.ds.notification": {
    "source": "iana"
  },
  "application/vnd.tableschema+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.tao.intent-module-archive": {
    "source": "iana",
    "extensions": [
      "tao"
    ]
  },
  "application/vnd.tcpdump.pcap": {
    "source": "iana",
    "extensions": [
      "pcap",
      "cap",
      "dmp"
    ]
  },
  "application/vnd.think-cell.ppttc+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.tmd.mediaflex.api+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.tml": {
    "source": "iana"
  },
  "application/vnd.tmobile-livetv": {
    "source": "iana",
    "extensions": [
      "tmo"
    ]
  },
  "application/vnd.tri.onesource": {
    "source": "iana"
  },
  "application/vnd.trid.tpt": {
    "source": "iana",
    "extensions": [
      "tpt"
    ]
  },
  "application/vnd.triscape.mxs": {
    "source": "iana",
    "extensions": [
      "mxs"
    ]
  },
  "application/vnd.trueapp": {
    "source": "iana",
    "extensions": [
      "tra"
    ]
  },
  "application/vnd.truedoc": {
    "source": "iana"
  },
  "application/vnd.ubisoft.webplayer": {
    "source": "iana"
  },
  "application/vnd.ufdl": {
    "source": "iana",
    "extensions": [
      "ufd",
      "ufdl"
    ]
  },
  "application/vnd.uiq.theme": {
    "source": "iana",
    "extensions": [
      "utz"
    ]
  },
  "application/vnd.umajin": {
    "source": "iana",
    "extensions": [
      "umj"
    ]
  },
  "application/vnd.unity": {
    "source": "iana",
    "extensions": [
      "unityweb"
    ]
  },
  "application/vnd.uoml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "uoml",
      "uo"
    ]
  },
  "application/vnd.uplanet.alert": {
    "source": "iana"
  },
  "application/vnd.uplanet.alert-wbxml": {
    "source": "iana"
  },
  "application/vnd.uplanet.bearer-choice": {
    "source": "iana"
  },
  "application/vnd.uplanet.bearer-choice-wbxml": {
    "source": "iana"
  },
  "application/vnd.uplanet.cacheop": {
    "source": "iana"
  },
  "application/vnd.uplanet.cacheop-wbxml": {
    "source": "iana"
  },
  "application/vnd.uplanet.channel": {
    "source": "iana"
  },
  "application/vnd.uplanet.channel-wbxml": {
    "source": "iana"
  },
  "application/vnd.uplanet.list": {
    "source": "iana"
  },
  "application/vnd.uplanet.list-wbxml": {
    "source": "iana"
  },
  "application/vnd.uplanet.listcmd": {
    "source": "iana"
  },
  "application/vnd.uplanet.listcmd-wbxml": {
    "source": "iana"
  },
  "application/vnd.uplanet.signal": {
    "source": "iana"
  },
  "application/vnd.uri-map": {
    "source": "iana"
  },
  "application/vnd.valve.source.material": {
    "source": "iana"
  },
  "application/vnd.vcx": {
    "source": "iana",
    "extensions": [
      "vcx"
    ]
  },
  "application/vnd.vd-study": {
    "source": "iana"
  },
  "application/vnd.vectorworks": {
    "source": "iana"
  },
  "application/vnd.vel+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.verimatrix.vcas": {
    "source": "iana"
  },
  "application/vnd.veritone.aion+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.veryant.thin": {
    "source": "iana"
  },
  "application/vnd.ves.encrypted": {
    "source": "iana"
  },
  "application/vnd.vidsoft.vidconference": {
    "source": "iana"
  },
  "application/vnd.visio": {
    "source": "iana",
    "extensions": [
      "vsd",
      "vst",
      "vss",
      "vsw"
    ]
  },
  "application/vnd.visionary": {
    "source": "iana",
    "extensions": [
      "vis"
    ]
  },
  "application/vnd.vividence.scriptfile": {
    "source": "iana"
  },
  "application/vnd.vsf": {
    "source": "iana",
    "extensions": [
      "vsf"
    ]
  },
  "application/vnd.wap.sic": {
    "source": "iana"
  },
  "application/vnd.wap.slc": {
    "source": "iana"
  },
  "application/vnd.wap.wbxml": {
    "source": "iana",
    "charset": "UTF-8",
    "extensions": [
      "wbxml"
    ]
  },
  "application/vnd.wap.wmlc": {
    "source": "iana",
    "extensions": [
      "wmlc"
    ]
  },
  "application/vnd.wap.wmlscriptc": {
    "source": "iana",
    "extensions": [
      "wmlsc"
    ]
  },
  "application/vnd.wasmflow.wafl": {
    "source": "iana"
  },
  "application/vnd.webturbo": {
    "source": "iana",
    "extensions": [
      "wtb"
    ]
  },
  "application/vnd.wfa.dpp": {
    "source": "iana"
  },
  "application/vnd.wfa.p2p": {
    "source": "iana"
  },
  "application/vnd.wfa.wsc": {
    "source": "iana"
  },
  "application/vnd.windows.devicepairing": {
    "source": "iana"
  },
  "application/vnd.wmc": {
    "source": "iana"
  },
  "application/vnd.wmf.bootstrap": {
    "source": "iana"
  },
  "application/vnd.wolfram.mathematica": {
    "source": "iana"
  },
  "application/vnd.wolfram.mathematica.package": {
    "source": "iana"
  },
  "application/vnd.wolfram.player": {
    "source": "iana",
    "extensions": [
      "nbp"
    ]
  },
  "application/vnd.wordlift": {
    "source": "iana"
  },
  "application/vnd.wordperfect": {
    "source": "iana",
    "extensions": [
      "wpd"
    ]
  },
  "application/vnd.wqd": {
    "source": "iana",
    "extensions": [
      "wqd"
    ]
  },
  "application/vnd.wrq-hp3000-labelled": {
    "source": "iana"
  },
  "application/vnd.wt.stf": {
    "source": "iana",
    "extensions": [
      "stf"
    ]
  },
  "application/vnd.wv.csp+wbxml": {
    "source": "iana"
  },
  "application/vnd.wv.csp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.wv.ssp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.xacml+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.xara": {
    "source": "iana",
    "extensions": [
      "xar"
    ]
  },
  "application/vnd.xecrets-encrypted": {
    "source": "iana"
  },
  "application/vnd.xfdl": {
    "source": "iana",
    "extensions": [
      "xfdl"
    ]
  },
  "application/vnd.xfdl.webform": {
    "source": "iana"
  },
  "application/vnd.xmi+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/vnd.xmpie.cpkg": {
    "source": "iana"
  },
  "application/vnd.xmpie.dpkg": {
    "source": "iana"
  },
  "application/vnd.xmpie.plan": {
    "source": "iana"
  },
  "application/vnd.xmpie.ppkg": {
    "source": "iana"
  },
  "application/vnd.xmpie.xlim": {
    "source": "iana"
  },
  "application/vnd.yamaha.hv-dic": {
    "source": "iana",
    "extensions": [
      "hvd"
    ]
  },
  "application/vnd.yamaha.hv-script": {
    "source": "iana",
    "extensions": [
      "hvs"
    ]
  },
  "application/vnd.yamaha.hv-voice": {
    "source": "iana",
    "extensions": [
      "hvp"
    ]
  },
  "application/vnd.yamaha.openscoreformat": {
    "source": "iana",
    "extensions": [
      "osf"
    ]
  },
  "application/vnd.yamaha.openscoreformat.osfpvg+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "osfpvg"
    ]
  },
  "application/vnd.yamaha.remote-setup": {
    "source": "iana"
  },
  "application/vnd.yamaha.smaf-audio": {
    "source": "iana",
    "extensions": [
      "saf"
    ]
  },
  "application/vnd.yamaha.smaf-phrase": {
    "source": "iana",
    "extensions": [
      "spf"
    ]
  },
  "application/vnd.yamaha.through-ngn": {
    "source": "iana"
  },
  "application/vnd.yamaha.tunnel-udpencap": {
    "source": "iana"
  },
  "application/vnd.yaoweme": {
    "source": "iana"
  },
  "application/vnd.yellowriver-custom-menu": {
    "source": "iana",
    "extensions": [
      "cmp"
    ]
  },
  "application/vnd.zul": {
    "source": "iana",
    "extensions": [
      "zir",
      "zirz"
    ]
  },
  "application/vnd.zzazz.deck+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "zaz"
    ]
  },
  "application/voicexml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "vxml"
    ]
  },
  "application/voucher-cms+json": {
    "source": "iana",
    "compressible": true
  },
  "application/vp": {
    "source": "iana"
  },
  "application/vq-rtcpxr": {
    "source": "iana"
  },
  "application/wasm": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "wasm"
    ]
  },
  "application/watcherinfo+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "wif"
    ]
  },
  "application/webpush-options+json": {
    "source": "iana",
    "compressible": true
  },
  "application/whoispp-query": {
    "source": "iana"
  },
  "application/whoispp-response": {
    "source": "iana"
  },
  "application/widget": {
    "source": "iana",
    "extensions": [
      "wgt"
    ]
  },
  "application/winhlp": {
    "source": "apache",
    "extensions": [
      "hlp"
    ]
  },
  "application/wita": {
    "source": "iana"
  },
  "application/wordperfect5.1": {
    "source": "iana"
  },
  "application/wsdl+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "wsdl"
    ]
  },
  "application/wspolicy+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "wspolicy"
    ]
  },
  "application/x-7z-compressed": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "7z"
    ]
  },
  "application/x-abiword": {
    "source": "apache",
    "extensions": [
      "abw"
    ]
  },
  "application/x-ace-compressed": {
    "source": "apache",
    "extensions": [
      "ace"
    ]
  },
  "application/x-amf": {
    "source": "apache"
  },
  "application/x-apple-diskimage": {
    "source": "apache",
    "extensions": [
      "dmg"
    ]
  },
  "application/x-arj": {
    "compressible": false,
    "extensions": [
      "arj"
    ]
  },
  "application/x-authorware-bin": {
    "source": "apache",
    "extensions": [
      "aab",
      "x32",
      "u32",
      "vox"
    ]
  },
  "application/x-authorware-map": {
    "source": "apache",
    "extensions": [
      "aam"
    ]
  },
  "application/x-authorware-seg": {
    "source": "apache",
    "extensions": [
      "aas"
    ]
  },
  "application/x-bcpio": {
    "source": "apache",
    "extensions": [
      "bcpio"
    ]
  },
  "application/x-bdoc": {
    "compressible": false,
    "extensions": [
      "bdoc"
    ]
  },
  "application/x-bittorrent": {
    "source": "apache",
    "extensions": [
      "torrent"
    ]
  },
  "application/x-blorb": {
    "source": "apache",
    "extensions": [
      "blb",
      "blorb"
    ]
  },
  "application/x-bzip": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "bz"
    ]
  },
  "application/x-bzip2": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "bz2",
      "boz"
    ]
  },
  "application/x-cbr": {
    "source": "apache",
    "extensions": [
      "cbr",
      "cba",
      "cbt",
      "cbz",
      "cb7"
    ]
  },
  "application/x-cdlink": {
    "source": "apache",
    "extensions": [
      "vcd"
    ]
  },
  "application/x-cfs-compressed": {
    "source": "apache",
    "extensions": [
      "cfs"
    ]
  },
  "application/x-chat": {
    "source": "apache",
    "extensions": [
      "chat"
    ]
  },
  "application/x-chess-pgn": {
    "source": "apache",
    "extensions": [
      "pgn"
    ]
  },
  "application/x-chrome-extension": {
    "extensions": [
      "crx"
    ]
  },
  "application/x-cocoa": {
    "source": "nginx",
    "extensions": [
      "cco"
    ]
  },
  "application/x-compress": {
    "source": "apache"
  },
  "application/x-conference": {
    "source": "apache",
    "extensions": [
      "nsc"
    ]
  },
  "application/x-cpio": {
    "source": "apache",
    "extensions": [
      "cpio"
    ]
  },
  "application/x-csh": {
    "source": "apache",
    "extensions": [
      "csh"
    ]
  },
  "application/x-deb": {
    "compressible": false
  },
  "application/x-debian-package": {
    "source": "apache",
    "extensions": [
      "deb",
      "udeb"
    ]
  },
  "application/x-dgc-compressed": {
    "source": "apache",
    "extensions": [
      "dgc"
    ]
  },
  "application/x-director": {
    "source": "apache",
    "extensions": [
      "dir",
      "dcr",
      "dxr",
      "cst",
      "cct",
      "cxt",
      "w3d",
      "fgd",
      "swa"
    ]
  },
  "application/x-doom": {
    "source": "apache",
    "extensions": [
      "wad"
    ]
  },
  "application/x-dtbncx+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "ncx"
    ]
  },
  "application/x-dtbook+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "dtb"
    ]
  },
  "application/x-dtbresource+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "res"
    ]
  },
  "application/x-dvi": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "dvi"
    ]
  },
  "application/x-envoy": {
    "source": "apache",
    "extensions": [
      "evy"
    ]
  },
  "application/x-eva": {
    "source": "apache",
    "extensions": [
      "eva"
    ]
  },
  "application/x-font-bdf": {
    "source": "apache",
    "extensions": [
      "bdf"
    ]
  },
  "application/x-font-dos": {
    "source": "apache"
  },
  "application/x-font-framemaker": {
    "source": "apache"
  },
  "application/x-font-ghostscript": {
    "source": "apache",
    "extensions": [
      "gsf"
    ]
  },
  "application/x-font-libgrx": {
    "source": "apache"
  },
  "application/x-font-linux-psf": {
    "source": "apache",
    "extensions": [
      "psf"
    ]
  },
  "application/x-font-pcf": {
    "source": "apache",
    "extensions": [
      "pcf"
    ]
  },
  "application/x-font-snf": {
    "source": "apache",
    "extensions": [
      "snf"
    ]
  },
  "application/x-font-speedo": {
    "source": "apache"
  },
  "application/x-font-sunos-news": {
    "source": "apache"
  },
  "application/x-font-type1": {
    "source": "apache",
    "extensions": [
      "pfa",
      "pfb",
      "pfm",
      "afm"
    ]
  },
  "application/x-font-vfont": {
    "source": "apache"
  },
  "application/x-freearc": {
    "source": "apache",
    "extensions": [
      "arc"
    ]
  },
  "application/x-futuresplash": {
    "source": "apache",
    "extensions": [
      "spl"
    ]
  },
  "application/x-gca-compressed": {
    "source": "apache",
    "extensions": [
      "gca"
    ]
  },
  "application/x-glulx": {
    "source": "apache",
    "extensions": [
      "ulx"
    ]
  },
  "application/x-gnumeric": {
    "source": "apache",
    "extensions": [
      "gnumeric"
    ]
  },
  "application/x-gramps-xml": {
    "source": "apache",
    "extensions": [
      "gramps"
    ]
  },
  "application/x-gtar": {
    "source": "apache",
    "extensions": [
      "gtar"
    ]
  },
  "application/x-gzip": {
    "source": "apache"
  },
  "application/x-hdf": {
    "source": "apache",
    "extensions": [
      "hdf"
    ]
  },
  "application/x-httpd-php": {
    "compressible": true,
    "extensions": [
      "php"
    ]
  },
  "application/x-install-instructions": {
    "source": "apache",
    "extensions": [
      "install"
    ]
  },
  "application/x-iso9660-image": {
    "source": "apache",
    "extensions": [
      "iso"
    ]
  },
  "application/x-iwork-keynote-sffkey": {
    "extensions": [
      "key"
    ]
  },
  "application/x-iwork-numbers-sffnumbers": {
    "extensions": [
      "numbers"
    ]
  },
  "application/x-iwork-pages-sffpages": {
    "extensions": [
      "pages"
    ]
  },
  "application/x-java-archive-diff": {
    "source": "nginx",
    "extensions": [
      "jardiff"
    ]
  },
  "application/x-java-jnlp-file": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "jnlp"
    ]
  },
  "application/x-javascript": {
    "compressible": true
  },
  "application/x-keepass2": {
    "extensions": [
      "kdbx"
    ]
  },
  "application/x-latex": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "latex"
    ]
  },
  "application/x-lua-bytecode": {
    "extensions": [
      "luac"
    ]
  },
  "application/x-lzh-compressed": {
    "source": "apache",
    "extensions": [
      "lzh",
      "lha"
    ]
  },
  "application/x-makeself": {
    "source": "nginx",
    "extensions": [
      "run"
    ]
  },
  "application/x-mie": {
    "source": "apache",
    "extensions": [
      "mie"
    ]
  },
  "application/x-mobipocket-ebook": {
    "source": "apache",
    "extensions": [
      "prc",
      "mobi"
    ]
  },
  "application/x-mpegurl": {
    "compressible": false
  },
  "application/x-ms-application": {
    "source": "apache",
    "extensions": [
      "application"
    ]
  },
  "application/x-ms-shortcut": {
    "source": "apache",
    "extensions": [
      "lnk"
    ]
  },
  "application/x-ms-wmd": {
    "source": "apache",
    "extensions": [
      "wmd"
    ]
  },
  "application/x-ms-wmz": {
    "source": "apache",
    "extensions": [
      "wmz"
    ]
  },
  "application/x-ms-xbap": {
    "source": "apache",
    "extensions": [
      "xbap"
    ]
  },
  "application/x-msaccess": {
    "source": "apache",
    "extensions": [
      "mdb"
    ]
  },
  "application/x-msbinder": {
    "source": "apache",
    "extensions": [
      "obd"
    ]
  },
  "application/x-mscardfile": {
    "source": "apache",
    "extensions": [
      "crd"
    ]
  },
  "application/x-msclip": {
    "source": "apache",
    "extensions": [
      "clp"
    ]
  },
  "application/x-msdos-program": {
    "extensions": [
      "exe"
    ]
  },
  "application/x-msdownload": {
    "source": "apache",
    "extensions": [
      "exe",
      "dll",
      "com",
      "bat",
      "msi"
    ]
  },
  "application/x-msmediaview": {
    "source": "apache",
    "extensions": [
      "mvb",
      "m13",
      "m14"
    ]
  },
  "application/x-msmetafile": {
    "source": "apache",
    "extensions": [
      "wmf",
      "wmz",
      "emf",
      "emz"
    ]
  },
  "application/x-msmoney": {
    "source": "apache",
    "extensions": [
      "mny"
    ]
  },
  "application/x-mspublisher": {
    "source": "apache",
    "extensions": [
      "pub"
    ]
  },
  "application/x-msschedule": {
    "source": "apache",
    "extensions": [
      "scd"
    ]
  },
  "application/x-msterminal": {
    "source": "apache",
    "extensions": [
      "trm"
    ]
  },
  "application/x-mswrite": {
    "source": "apache",
    "extensions": [
      "wri"
    ]
  },
  "application/x-netcdf": {
    "source": "apache",
    "extensions": [
      "nc",
      "cdf"
    ]
  },
  "application/x-ns-proxy-autoconfig": {
    "compressible": true,
    "extensions": [
      "pac"
    ]
  },
  "application/x-nzb": {
    "source": "apache",
    "extensions": [
      "nzb"
    ]
  },
  "application/x-perl": {
    "source": "nginx",
    "extensions": [
      "pl",
      "pm"
    ]
  },
  "application/x-pilot": {
    "source": "nginx",
    "extensions": [
      "prc",
      "pdb"
    ]
  },
  "application/x-pkcs12": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "p12",
      "pfx"
    ]
  },
  "application/x-pkcs7-certificates": {
    "source": "apache",
    "extensions": [
      "p7b",
      "spc"
    ]
  },
  "application/x-pkcs7-certreqresp": {
    "source": "apache",
    "extensions": [
      "p7r"
    ]
  },
  "application/x-pki-message": {
    "source": "iana"
  },
  "application/x-rar-compressed": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "rar"
    ]
  },
  "application/x-redhat-package-manager": {
    "source": "nginx",
    "extensions": [
      "rpm"
    ]
  },
  "application/x-research-info-systems": {
    "source": "apache",
    "extensions": [
      "ris"
    ]
  },
  "application/x-sea": {
    "source": "nginx",
    "extensions": [
      "sea"
    ]
  },
  "application/x-sh": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "sh"
    ]
  },
  "application/x-shar": {
    "source": "apache",
    "extensions": [
      "shar"
    ]
  },
  "application/x-shockwave-flash": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "swf"
    ]
  },
  "application/x-silverlight-app": {
    "source": "apache",
    "extensions": [
      "xap"
    ]
  },
  "application/x-sql": {
    "source": "apache",
    "extensions": [
      "sql"
    ]
  },
  "application/x-stuffit": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "sit"
    ]
  },
  "application/x-stuffitx": {
    "source": "apache",
    "extensions": [
      "sitx"
    ]
  },
  "application/x-subrip": {
    "source": "apache",
    "extensions": [
      "srt"
    ]
  },
  "application/x-sv4cpio": {
    "source": "apache",
    "extensions": [
      "sv4cpio"
    ]
  },
  "application/x-sv4crc": {
    "source": "apache",
    "extensions": [
      "sv4crc"
    ]
  },
  "application/x-t3vm-image": {
    "source": "apache",
    "extensions": [
      "t3"
    ]
  },
  "application/x-tads": {
    "source": "apache",
    "extensions": [
      "gam"
    ]
  },
  "application/x-tar": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "tar"
    ]
  },
  "application/x-tcl": {
    "source": "apache",
    "extensions": [
      "tcl",
      "tk"
    ]
  },
  "application/x-tex": {
    "source": "apache",
    "extensions": [
      "tex"
    ]
  },
  "application/x-tex-tfm": {
    "source": "apache",
    "extensions": [
      "tfm"
    ]
  },
  "application/x-texinfo": {
    "source": "apache",
    "extensions": [
      "texinfo",
      "texi"
    ]
  },
  "application/x-tgif": {
    "source": "apache",
    "extensions": [
      "obj"
    ]
  },
  "application/x-ustar": {
    "source": "apache",
    "extensions": [
      "ustar"
    ]
  },
  "application/x-virtualbox-hdd": {
    "compressible": true,
    "extensions": [
      "hdd"
    ]
  },
  "application/x-virtualbox-ova": {
    "compressible": true,
    "extensions": [
      "ova"
    ]
  },
  "application/x-virtualbox-ovf": {
    "compressible": true,
    "extensions": [
      "ovf"
    ]
  },
  "application/x-virtualbox-vbox": {
    "compressible": true,
    "extensions": [
      "vbox"
    ]
  },
  "application/x-virtualbox-vbox-extpack": {
    "compressible": false,
    "extensions": [
      "vbox-extpack"
    ]
  },
  "application/x-virtualbox-vdi": {
    "compressible": true,
    "extensions": [
      "vdi"
    ]
  },
  "application/x-virtualbox-vhd": {
    "compressible": true,
    "extensions": [
      "vhd"
    ]
  },
  "application/x-virtualbox-vmdk": {
    "compressible": true,
    "extensions": [
      "vmdk"
    ]
  },
  "application/x-wais-source": {
    "source": "apache",
    "extensions": [
      "src"
    ]
  },
  "application/x-web-app-manifest+json": {
    "compressible": true,
    "extensions": [
      "webapp"
    ]
  },
  "application/x-www-form-urlencoded": {
    "source": "iana",
    "compressible": true
  },
  "application/x-x509-ca-cert": {
    "source": "iana",
    "extensions": [
      "der",
      "crt",
      "pem"
    ]
  },
  "application/x-x509-ca-ra-cert": {
    "source": "iana"
  },
  "application/x-x509-next-ca-cert": {
    "source": "iana"
  },
  "application/x-xfig": {
    "source": "apache",
    "extensions": [
      "fig"
    ]
  },
  "application/x-xliff+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "xlf"
    ]
  },
  "application/x-xpinstall": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "xpi"
    ]
  },
  "application/x-xz": {
    "source": "apache",
    "extensions": [
      "xz"
    ]
  },
  "application/x-zmachine": {
    "source": "apache",
    "extensions": [
      "z1",
      "z2",
      "z3",
      "z4",
      "z5",
      "z6",
      "z7",
      "z8"
    ]
  },
  "application/x400-bp": {
    "source": "iana"
  },
  "application/xacml+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/xaml+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "xaml"
    ]
  },
  "application/xcap-att+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xav"
    ]
  },
  "application/xcap-caps+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xca"
    ]
  },
  "application/xcap-diff+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xdf"
    ]
  },
  "application/xcap-el+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xel"
    ]
  },
  "application/xcap-error+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/xcap-ns+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xns"
    ]
  },
  "application/xcon-conference-info+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/xcon-conference-info-diff+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/xenc+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xenc"
    ]
  },
  "application/xfdf": {
    "source": "iana",
    "extensions": [
      "xfdf"
    ]
  },
  "application/xhtml+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xhtml",
      "xht"
    ]
  },
  "application/xhtml-voice+xml": {
    "source": "apache",
    "compressible": true
  },
  "application/xliff+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xlf"
    ]
  },
  "application/xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xml",
      "xsl",
      "xsd",
      "rng"
    ]
  },
  "application/xml-dtd": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "dtd"
    ]
  },
  "application/xml-external-parsed-entity": {
    "source": "iana"
  },
  "application/xml-patch+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/xmpp+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/xop+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xop"
    ]
  },
  "application/xproc+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "xpl"
    ]
  },
  "application/xslt+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xsl",
      "xslt"
    ]
  },
  "application/xspf+xml": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "xspf"
    ]
  },
  "application/xv+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "mxml",
      "xhvml",
      "xvml",
      "xvm"
    ]
  },
  "application/yaml": {
    "source": "iana"
  },
  "application/yang": {
    "source": "iana",
    "extensions": [
      "yang"
    ]
  },
  "application/yang-data+cbor": {
    "source": "iana"
  },
  "application/yang-data+json": {
    "source": "iana",
    "compressible": true
  },
  "application/yang-data+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/yang-patch+json": {
    "source": "iana",
    "compressible": true
  },
  "application/yang-patch+xml": {
    "source": "iana",
    "compressible": true
  },
  "application/yang-sid+json": {
    "source": "iana",
    "compressible": true
  },
  "application/yin+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "yin"
    ]
  },
  "application/zip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "zip"
    ]
  },
  "application/zlib": {
    "source": "iana"
  },
  "application/zstd": {
    "source": "iana"
  },
  "audio/1d-interleaved-parityfec": {
    "source": "iana"
  },
  "audio/32kadpcm": {
    "source": "iana"
  },
  "audio/3gpp": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "3gpp"
    ]
  },
  "audio/3gpp2": {
    "source": "iana"
  },
  "audio/aac": {
    "source": "iana",
    "extensions": [
      "adts",
      "aac"
    ]
  },
  "audio/ac3": {
    "source": "iana"
  },
  "audio/adpcm": {
    "source": "apache",
    "extensions": [
      "adp"
    ]
  },
  "audio/amr": {
    "source": "iana",
    "extensions": [
      "amr"
    ]
  },
  "audio/amr-wb": {
    "source": "iana"
  },
  "audio/amr-wb+": {
    "source": "iana"
  },
  "audio/aptx": {
    "source": "iana"
  },
  "audio/asc": {
    "source": "iana"
  },
  "audio/atrac-advanced-lossless": {
    "source": "iana"
  },
  "audio/atrac-x": {
    "source": "iana"
  },
  "audio/atrac3": {
    "source": "iana"
  },
  "audio/basic": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "au",
      "snd"
    ]
  },
  "audio/bv16": {
    "source": "iana"
  },
  "audio/bv32": {
    "source": "iana"
  },
  "audio/clearmode": {
    "source": "iana"
  },
  "audio/cn": {
    "source": "iana"
  },
  "audio/dat12": {
    "source": "iana"
  },
  "audio/dls": {
    "source": "iana"
  },
  "audio/dsr-es201108": {
    "source": "iana"
  },
  "audio/dsr-es202050": {
    "source": "iana"
  },
  "audio/dsr-es202211": {
    "source": "iana"
  },
  "audio/dsr-es202212": {
    "source": "iana"
  },
  "audio/dv": {
    "source": "iana"
  },
  "audio/dvi4": {
    "source": "iana"
  },
  "audio/eac3": {
    "source": "iana"
  },
  "audio/encaprtp": {
    "source": "iana"
  },
  "audio/evrc": {
    "source": "iana"
  },
  "audio/evrc-qcp": {
    "source": "iana"
  },
  "audio/evrc0": {
    "source": "iana"
  },
  "audio/evrc1": {
    "source": "iana"
  },
  "audio/evrcb": {
    "source": "iana"
  },
  "audio/evrcb0": {
    "source": "iana"
  },
  "audio/evrcb1": {
    "source": "iana"
  },
  "audio/evrcnw": {
    "source": "iana"
  },
  "audio/evrcnw0": {
    "source": "iana"
  },
  "audio/evrcnw1": {
    "source": "iana"
  },
  "audio/evrcwb": {
    "source": "iana"
  },
  "audio/evrcwb0": {
    "source": "iana"
  },
  "audio/evrcwb1": {
    "source": "iana"
  },
  "audio/evs": {
    "source": "iana"
  },
  "audio/flac": {
    "source": "iana"
  },
  "audio/flexfec": {
    "source": "iana"
  },
  "audio/fwdred": {
    "source": "iana"
  },
  "audio/g711-0": {
    "source": "iana"
  },
  "audio/g719": {
    "source": "iana"
  },
  "audio/g722": {
    "source": "iana"
  },
  "audio/g7221": {
    "source": "iana"
  },
  "audio/g723": {
    "source": "iana"
  },
  "audio/g726-16": {
    "source": "iana"
  },
  "audio/g726-24": {
    "source": "iana"
  },
  "audio/g726-32": {
    "source": "iana"
  },
  "audio/g726-40": {
    "source": "iana"
  },
  "audio/g728": {
    "source": "iana"
  },
  "audio/g729": {
    "source": "iana"
  },
  "audio/g7291": {
    "source": "iana"
  },
  "audio/g729d": {
    "source": "iana"
  },
  "audio/g729e": {
    "source": "iana"
  },
  "audio/gsm": {
    "source": "iana"
  },
  "audio/gsm-efr": {
    "source": "iana"
  },
  "audio/gsm-hr-08": {
    "source": "iana"
  },
  "audio/ilbc": {
    "source": "iana"
  },
  "audio/ip-mr_v2.5": {
    "source": "iana"
  },
  "audio/isac": {
    "source": "apache"
  },
  "audio/l16": {
    "source": "iana"
  },
  "audio/l20": {
    "source": "iana"
  },
  "audio/l24": {
    "source": "iana",
    "compressible": false
  },
  "audio/l8": {
    "source": "iana"
  },
  "audio/lpc": {
    "source": "iana"
  },
  "audio/matroska": {
    "source": "iana"
  },
  "audio/melp": {
    "source": "iana"
  },
  "audio/melp1200": {
    "source": "iana"
  },
  "audio/melp2400": {
    "source": "iana"
  },
  "audio/melp600": {
    "source": "iana"
  },
  "audio/mhas": {
    "source": "iana"
  },
  "audio/midi": {
    "source": "apache",
    "extensions": [
      "mid",
      "midi",
      "kar",
      "rmi"
    ]
  },
  "audio/midi-clip": {
    "source": "iana"
  },
  "audio/mobile-xmf": {
    "source": "iana",
    "extensions": [
      "mxmf"
    ]
  },
  "audio/mp3": {
    "compressible": false,
    "extensions": [
      "mp3"
    ]
  },
  "audio/mp4": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "m4a",
      "mp4a"
    ]
  },
  "audio/mp4a-latm": {
    "source": "iana"
  },
  "audio/mpa": {
    "source": "iana"
  },
  "audio/mpa-robust": {
    "source": "iana"
  },
  "audio/mpeg": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "mpga",
      "mp2",
      "mp2a",
      "mp3",
      "m2a",
      "m3a"
    ]
  },
  "audio/mpeg4-generic": {
    "source": "iana"
  },
  "audio/musepack": {
    "source": "apache"
  },
  "audio/ogg": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "oga",
      "ogg",
      "spx",
      "opus"
    ]
  },
  "audio/opus": {
    "source": "iana"
  },
  "audio/parityfec": {
    "source": "iana"
  },
  "audio/pcma": {
    "source": "iana"
  },
  "audio/pcma-wb": {
    "source": "iana"
  },
  "audio/pcmu": {
    "source": "iana"
  },
  "audio/pcmu-wb": {
    "source": "iana"
  },
  "audio/prs.sid": {
    "source": "iana"
  },
  "audio/qcelp": {
    "source": "iana"
  },
  "audio/raptorfec": {
    "source": "iana"
  },
  "audio/red": {
    "source": "iana"
  },
  "audio/rtp-enc-aescm128": {
    "source": "iana"
  },
  "audio/rtp-midi": {
    "source": "iana"
  },
  "audio/rtploopback": {
    "source": "iana"
  },
  "audio/rtx": {
    "source": "iana"
  },
  "audio/s3m": {
    "source": "apache",
    "extensions": [
      "s3m"
    ]
  },
  "audio/scip": {
    "source": "iana"
  },
  "audio/silk": {
    "source": "apache",
    "extensions": [
      "sil"
    ]
  },
  "audio/smv": {
    "source": "iana"
  },
  "audio/smv-qcp": {
    "source": "iana"
  },
  "audio/smv0": {
    "source": "iana"
  },
  "audio/sofa": {
    "source": "iana"
  },
  "audio/sp-midi": {
    "source": "iana"
  },
  "audio/speex": {
    "source": "iana"
  },
  "audio/t140c": {
    "source": "iana"
  },
  "audio/t38": {
    "source": "iana"
  },
  "audio/telephone-event": {
    "source": "iana"
  },
  "audio/tetra_acelp": {
    "source": "iana"
  },
  "audio/tetra_acelp_bb": {
    "source": "iana"
  },
  "audio/tone": {
    "source": "iana"
  },
  "audio/tsvcis": {
    "source": "iana"
  },
  "audio/uemclip": {
    "source": "iana"
  },
  "audio/ulpfec": {
    "source": "iana"
  },
  "audio/usac": {
    "source": "iana"
  },
  "audio/vdvi": {
    "source": "iana"
  },
  "audio/vmr-wb": {
    "source": "iana"
  },
  "audio/vnd.3gpp.iufp": {
    "source": "iana"
  },
  "audio/vnd.4sb": {
    "source": "iana"
  },
  "audio/vnd.audiokoz": {
    "source": "iana"
  },
  "audio/vnd.celp": {
    "source": "iana"
  },
  "audio/vnd.cisco.nse": {
    "source": "iana"
  },
  "audio/vnd.cmles.radio-events": {
    "source": "iana"
  },
  "audio/vnd.cns.anp1": {
    "source": "iana"
  },
  "audio/vnd.cns.inf1": {
    "source": "iana"
  },
  "audio/vnd.dece.audio": {
    "source": "iana",
    "extensions": [
      "uva",
      "uvva"
    ]
  },
  "audio/vnd.digital-winds": {
    "source": "iana",
    "extensions": [
      "eol"
    ]
  },
  "audio/vnd.dlna.adts": {
    "source": "iana"
  },
  "audio/vnd.dolby.heaac.1": {
    "source": "iana"
  },
  "audio/vnd.dolby.heaac.2": {
    "source": "iana"
  },
  "audio/vnd.dolby.mlp": {
    "source": "iana"
  },
  "audio/vnd.dolby.mps": {
    "source": "iana"
  },
  "audio/vnd.dolby.pl2": {
    "source": "iana"
  },
  "audio/vnd.dolby.pl2x": {
    "source": "iana"
  },
  "audio/vnd.dolby.pl2z": {
    "source": "iana"
  },
  "audio/vnd.dolby.pulse.1": {
    "source": "iana"
  },
  "audio/vnd.dra": {
    "source": "iana",
    "extensions": [
      "dra"
    ]
  },
  "audio/vnd.dts": {
    "source": "iana",
    "extensions": [
      "dts"
    ]
  },
  "audio/vnd.dts.hd": {
    "source": "iana",
    "extensions": [
      "dtshd"
    ]
  },
  "audio/vnd.dts.uhd": {
    "source": "iana"
  },
  "audio/vnd.dvb.file": {
    "source": "iana"
  },
  "audio/vnd.everad.plj": {
    "source": "iana"
  },
  "audio/vnd.hns.audio": {
    "source": "iana"
  },
  "audio/vnd.lucent.voice": {
    "source": "iana",
    "extensions": [
      "lvp"
    ]
  },
  "audio/vnd.ms-playready.media.pya": {
    "source": "iana",
    "extensions": [
      "pya"
    ]
  },
  "audio/vnd.nokia.mobile-xmf": {
    "source": "iana"
  },
  "audio/vnd.nortel.vbk": {
    "source": "iana"
  },
  "audio/vnd.nuera.ecelp4800": {
    "source": "iana",
    "extensions": [
      "ecelp4800"
    ]
  },
  "audio/vnd.nuera.ecelp7470": {
    "source": "iana",
    "extensions": [
      "ecelp7470"
    ]
  },
  "audio/vnd.nuera.ecelp9600": {
    "source": "iana",
    "extensions": [
      "ecelp9600"
    ]
  },
  "audio/vnd.octel.sbc": {
    "source": "iana"
  },
  "audio/vnd.presonus.multitrack": {
    "source": "iana"
  },
  "audio/vnd.qcelp": {
    "source": "apache"
  },
  "audio/vnd.rhetorex.32kadpcm": {
    "source": "iana"
  },
  "audio/vnd.rip": {
    "source": "iana",
    "extensions": [
      "rip"
    ]
  },
  "audio/vnd.rn-realaudio": {
    "compressible": false
  },
  "audio/vnd.sealedmedia.softseal.mpeg": {
    "source": "iana"
  },
  "audio/vnd.vmx.cvsd": {
    "source": "iana"
  },
  "audio/vnd.wave": {
    "compressible": false
  },
  "audio/vorbis": {
    "source": "iana",
    "compressible": false
  },
  "audio/vorbis-config": {
    "source": "iana"
  },
  "audio/wav": {
    "compressible": false,
    "extensions": [
      "wav"
    ]
  },
  "audio/wave": {
    "compressible": false,
    "extensions": [
      "wav"
    ]
  },
  "audio/webm": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "weba"
    ]
  },
  "audio/x-aac": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "aac"
    ]
  },
  "audio/x-aiff": {
    "source": "apache",
    "extensions": [
      "aif",
      "aiff",
      "aifc"
    ]
  },
  "audio/x-caf": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "caf"
    ]
  },
  "audio/x-flac": {
    "source": "apache",
    "extensions": [
      "flac"
    ]
  },
  "audio/x-m4a": {
    "source": "nginx",
    "extensions": [
      "m4a"
    ]
  },
  "audio/x-matroska": {
    "source": "apache",
    "extensions": [
      "mka"
    ]
  },
  "audio/x-mpegurl": {
    "source": "apache",
    "extensions": [
      "m3u"
    ]
  },
  "audio/x-ms-wax": {
    "source": "apache",
    "extensions": [
      "wax"
    ]
  },
  "audio/x-ms-wma": {
    "source": "apache",
    "extensions": [
      "wma"
    ]
  },
  "audio/x-pn-realaudio": {
    "source": "apache",
    "extensions": [
      "ram",
      "ra"
    ]
  },
  "audio/x-pn-realaudio-plugin": {
    "source": "apache",
    "extensions": [
      "rmp"
    ]
  },
  "audio/x-realaudio": {
    "source": "nginx",
    "extensions": [
      "ra"
    ]
  },
  "audio/x-tta": {
    "source": "apache"
  },
  "audio/x-wav": {
    "source": "apache",
    "extensions": [
      "wav"
    ]
  },
  "audio/xm": {
    "source": "apache",
    "extensions": [
      "xm"
    ]
  },
  "chemical/x-cdx": {
    "source": "apache",
    "extensions": [
      "cdx"
    ]
  },
  "chemical/x-cif": {
    "source": "apache",
    "extensions": [
      "cif"
    ]
  },
  "chemical/x-cmdf": {
    "source": "apache",
    "extensions": [
      "cmdf"
    ]
  },
  "chemical/x-cml": {
    "source": "apache",
    "extensions": [
      "cml"
    ]
  },
  "chemical/x-csml": {
    "source": "apache",
    "extensions": [
      "csml"
    ]
  },
  "chemical/x-pdb": {
    "source": "apache"
  },
  "chemical/x-xyz": {
    "source": "apache",
    "extensions": [
      "xyz"
    ]
  },
  "font/collection": {
    "source": "iana",
    "extensions": [
      "ttc"
    ]
  },
  "font/otf": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "otf"
    ]
  },
  "font/sfnt": {
    "source": "iana"
  },
  "font/ttf": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ttf"
    ]
  },
  "font/woff": {
    "source": "iana",
    "extensions": [
      "woff"
    ]
  },
  "font/woff2": {
    "source": "iana",
    "extensions": [
      "woff2"
    ]
  },
  "image/aces": {
    "source": "iana",
    "extensions": [
      "exr"
    ]
  },
  "image/apng": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "apng"
    ]
  },
  "image/avci": {
    "source": "iana",
    "extensions": [
      "avci"
    ]
  },
  "image/avcs": {
    "source": "iana",
    "extensions": [
      "avcs"
    ]
  },
  "image/avif": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "avif"
    ]
  },
  "image/bmp": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "bmp",
      "dib"
    ]
  },
  "image/cgm": {
    "source": "iana",
    "extensions": [
      "cgm"
    ]
  },
  "image/dicom-rle": {
    "source": "iana",
    "extensions": [
      "drle"
    ]
  },
  "image/dpx": {
    "source": "iana",
    "extensions": [
      "dpx"
    ]
  },
  "image/emf": {
    "source": "iana",
    "extensions": [
      "emf"
    ]
  },
  "image/fits": {
    "source": "iana",
    "extensions": [
      "fits"
    ]
  },
  "image/g3fax": {
    "source": "iana",
    "extensions": [
      "g3"
    ]
  },
  "image/gif": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "gif"
    ]
  },
  "image/heic": {
    "source": "iana",
    "extensions": [
      "heic"
    ]
  },
  "image/heic-sequence": {
    "source": "iana",
    "extensions": [
      "heics"
    ]
  },
  "image/heif": {
    "source": "iana",
    "extensions": [
      "heif"
    ]
  },
  "image/heif-sequence": {
    "source": "iana",
    "extensions": [
      "heifs"
    ]
  },
  "image/hej2k": {
    "source": "iana",
    "extensions": [
      "hej2"
    ]
  },
  "image/hsj2": {
    "source": "iana",
    "extensions": [
      "hsj2"
    ]
  },
  "image/ief": {
    "source": "iana",
    "extensions": [
      "ief"
    ]
  },
  "image/j2c": {
    "source": "iana"
  },
  "image/jls": {
    "source": "iana",
    "extensions": [
      "jls"
    ]
  },
  "image/jp2": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "jp2",
      "jpg2"
    ]
  },
  "image/jpeg": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "jpeg",
      "jpg",
      "jpe"
    ]
  },
  "image/jph": {
    "source": "iana",
    "extensions": [
      "jph"
    ]
  },
  "image/jphc": {
    "source": "iana",
    "extensions": [
      "jhc"
    ]
  },
  "image/jpm": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "jpm",
      "jpgm"
    ]
  },
  "image/jpx": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "jpx",
      "jpf"
    ]
  },
  "image/jxl": {
    "source": "iana",
    "extensions": [
      "jxl"
    ]
  },
  "image/jxr": {
    "source": "iana",
    "extensions": [
      "jxr"
    ]
  },
  "image/jxra": {
    "source": "iana",
    "extensions": [
      "jxra"
    ]
  },
  "image/jxrs": {
    "source": "iana",
    "extensions": [
      "jxrs"
    ]
  },
  "image/jxs": {
    "source": "iana",
    "extensions": [
      "jxs"
    ]
  },
  "image/jxsc": {
    "source": "iana",
    "extensions": [
      "jxsc"
    ]
  },
  "image/jxsi": {
    "source": "iana",
    "extensions": [
      "jxsi"
    ]
  },
  "image/jxss": {
    "source": "iana",
    "extensions": [
      "jxss"
    ]
  },
  "image/ktx": {
    "source": "iana",
    "extensions": [
      "ktx"
    ]
  },
  "image/ktx2": {
    "source": "iana",
    "extensions": [
      "ktx2"
    ]
  },
  "image/naplps": {
    "source": "iana"
  },
  "image/pjpeg": {
    "compressible": false
  },
  "image/png": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "png"
    ]
  },
  "image/prs.btif": {
    "source": "iana",
    "extensions": [
      "btif",
      "btf"
    ]
  },
  "image/prs.pti": {
    "source": "iana",
    "extensions": [
      "pti"
    ]
  },
  "image/pwg-raster": {
    "source": "iana"
  },
  "image/sgi": {
    "source": "apache",
    "extensions": [
      "sgi"
    ]
  },
  "image/svg+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "svg",
      "svgz"
    ]
  },
  "image/t38": {
    "source": "iana",
    "extensions": [
      "t38"
    ]
  },
  "image/tiff": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "tif",
      "tiff"
    ]
  },
  "image/tiff-fx": {
    "source": "iana",
    "extensions": [
      "tfx"
    ]
  },
  "image/vnd.adobe.photoshop": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "psd"
    ]
  },
  "image/vnd.airzip.accelerator.azv": {
    "source": "iana",
    "extensions": [
      "azv"
    ]
  },
  "image/vnd.cns.inf2": {
    "source": "iana"
  },
  "image/vnd.dece.graphic": {
    "source": "iana",
    "extensions": [
      "uvi",
      "uvvi",
      "uvg",
      "uvvg"
    ]
  },
  "image/vnd.djvu": {
    "source": "iana",
    "extensions": [
      "djvu",
      "djv"
    ]
  },
  "image/vnd.dvb.subtitle": {
    "source": "iana",
    "extensions": [
      "sub"
    ]
  },
  "image/vnd.dwg": {
    "source": "iana",
    "extensions": [
      "dwg"
    ]
  },
  "image/vnd.dxf": {
    "source": "iana",
    "extensions": [
      "dxf"
    ]
  },
  "image/vnd.fastbidsheet": {
    "source": "iana",
    "extensions": [
      "fbs"
    ]
  },
  "image/vnd.fpx": {
    "source": "iana",
    "extensions": [
      "fpx"
    ]
  },
  "image/vnd.fst": {
    "source": "iana",
    "extensions": [
      "fst"
    ]
  },
  "image/vnd.fujixerox.edmics-mmr": {
    "source": "iana",
    "extensions": [
      "mmr"
    ]
  },
  "image/vnd.fujixerox.edmics-rlc": {
    "source": "iana",
    "extensions": [
      "rlc"
    ]
  },
  "image/vnd.globalgraphics.pgb": {
    "source": "iana"
  },
  "image/vnd.microsoft.icon": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "ico"
    ]
  },
  "image/vnd.mix": {
    "source": "iana"
  },
  "image/vnd.mozilla.apng": {
    "source": "iana"
  },
  "image/vnd.ms-dds": {
    "compressible": true,
    "extensions": [
      "dds"
    ]
  },
  "image/vnd.ms-modi": {
    "source": "iana",
    "extensions": [
      "mdi"
    ]
  },
  "image/vnd.ms-photo": {
    "source": "apache",
    "extensions": [
      "wdp"
    ]
  },
  "image/vnd.net-fpx": {
    "source": "iana",
    "extensions": [
      "npx"
    ]
  },
  "image/vnd.pco.b16": {
    "source": "iana",
    "extensions": [
      "b16"
    ]
  },
  "image/vnd.radiance": {
    "source": "iana"
  },
  "image/vnd.sealed.png": {
    "source": "iana"
  },
  "image/vnd.sealedmedia.softseal.gif": {
    "source": "iana"
  },
  "image/vnd.sealedmedia.softseal.jpg": {
    "source": "iana"
  },
  "image/vnd.svf": {
    "source": "iana"
  },
  "image/vnd.tencent.tap": {
    "source": "iana",
    "extensions": [
      "tap"
    ]
  },
  "image/vnd.valve.source.texture": {
    "source": "iana",
    "extensions": [
      "vtf"
    ]
  },
  "image/vnd.wap.wbmp": {
    "source": "iana",
    "extensions": [
      "wbmp"
    ]
  },
  "image/vnd.xiff": {
    "source": "iana",
    "extensions": [
      "xif"
    ]
  },
  "image/vnd.zbrush.pcx": {
    "source": "iana",
    "extensions": [
      "pcx"
    ]
  },
  "image/webp": {
    "source": "iana",
    "extensions": [
      "webp"
    ]
  },
  "image/wmf": {
    "source": "iana",
    "extensions": [
      "wmf"
    ]
  },
  "image/x-3ds": {
    "source": "apache",
    "extensions": [
      "3ds"
    ]
  },
  "image/x-cmu-raster": {
    "source": "apache",
    "extensions": [
      "ras"
    ]
  },
  "image/x-cmx": {
    "source": "apache",
    "extensions": [
      "cmx"
    ]
  },
  "image/x-freehand": {
    "source": "apache",
    "extensions": [
      "fh",
      "fhc",
      "fh4",
      "fh5",
      "fh7"
    ]
  },
  "image/x-icon": {
    "source": "apache",
    "compressible": true,
    "extensions": [
      "ico"
    ]
  },
  "image/x-jng": {
    "source": "nginx",
    "extensions": [
      "jng"
    ]
  },
  "image/x-mrsid-image": {
    "source": "apache",
    "extensions": [
      "sid"
    ]
  },
  "image/x-ms-bmp": {
    "source": "nginx",
    "compressible": true,
    "extensions": [
      "bmp"
    ]
  },
  "image/x-pcx": {
    "source": "apache",
    "extensions": [
      "pcx"
    ]
  },
  "image/x-pict": {
    "source": "apache",
    "extensions": [
      "pic",
      "pct"
    ]
  },
  "image/x-portable-anymap": {
    "source": "apache",
    "extensions": [
      "pnm"
    ]
  },
  "image/x-portable-bitmap": {
    "source": "apache",
    "extensions": [
      "pbm"
    ]
  },
  "image/x-portable-graymap": {
    "source": "apache",
    "extensions": [
      "pgm"
    ]
  },
  "image/x-portable-pixmap": {
    "source": "apache",
    "extensions": [
      "ppm"
    ]
  },
  "image/x-rgb": {
    "source": "apache",
    "extensions": [
      "rgb"
    ]
  },
  "image/x-tga": {
    "source": "apache",
    "extensions": [
      "tga"
    ]
  },
  "image/x-xbitmap": {
    "source": "apache",
    "extensions": [
      "xbm"
    ]
  },
  "image/x-xcf": {
    "compressible": false
  },
  "image/x-xpixmap": {
    "source": "apache",
    "extensions": [
      "xpm"
    ]
  },
  "image/x-xwindowdump": {
    "source": "apache",
    "extensions": [
      "xwd"
    ]
  },
  "message/bhttp": {
    "source": "iana"
  },
  "message/cpim": {
    "source": "iana"
  },
  "message/delivery-status": {
    "source": "iana"
  },
  "message/disposition-notification": {
    "source": "iana",
    "extensions": [
      "disposition-notification"
    ]
  },
  "message/external-body": {
    "source": "iana"
  },
  "message/feedback-report": {
    "source": "iana"
  },
  "message/global": {
    "source": "iana",
    "extensions": [
      "u8msg"
    ]
  },
  "message/global-delivery-status": {
    "source": "iana",
    "extensions": [
      "u8dsn"
    ]
  },
  "message/global-disposition-notification": {
    "source": "iana",
    "extensions": [
      "u8mdn"
    ]
  },
  "message/global-headers": {
    "source": "iana",
    "extensions": [
      "u8hdr"
    ]
  },
  "message/http": {
    "source": "iana",
    "compressible": false
  },
  "message/imdn+xml": {
    "source": "iana",
    "compressible": true
  },
  "message/mls": {
    "source": "iana"
  },
  "message/news": {
    "source": "apache"
  },
  "message/ohttp-req": {
    "source": "iana"
  },
  "message/ohttp-res": {
    "source": "iana"
  },
  "message/partial": {
    "source": "iana",
    "compressible": false
  },
  "message/rfc822": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "eml",
      "mime"
    ]
  },
  "message/s-http": {
    "source": "apache"
  },
  "message/sip": {
    "source": "iana"
  },
  "message/sipfrag": {
    "source": "iana"
  },
  "message/tracking-status": {
    "source": "iana"
  },
  "message/vnd.si.simp": {
    "source": "apache"
  },
  "message/vnd.wfa.wsc": {
    "source": "iana",
    "extensions": [
      "wsc"
    ]
  },
  "model/3mf": {
    "source": "iana",
    "extensions": [
      "3mf"
    ]
  },
  "model/e57": {
    "source": "iana"
  },
  "model/gltf+json": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "gltf"
    ]
  },
  "model/gltf-binary": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "glb"
    ]
  },
  "model/iges": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "igs",
      "iges"
    ]
  },
  "model/jt": {
    "source": "iana",
    "extensions": [
      "jt"
    ]
  },
  "model/mesh": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "msh",
      "mesh",
      "silo"
    ]
  },
  "model/mtl": {
    "source": "iana",
    "extensions": [
      "mtl"
    ]
  },
  "model/obj": {
    "source": "iana",
    "extensions": [
      "obj"
    ]
  },
  "model/prc": {
    "source": "iana",
    "extensions": [
      "prc"
    ]
  },
  "model/step": {
    "source": "iana"
  },
  "model/step+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "stpx"
    ]
  },
  "model/step+zip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "stpz"
    ]
  },
  "model/step-xml+zip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "stpxz"
    ]
  },
  "model/stl": {
    "source": "iana",
    "extensions": [
      "stl"
    ]
  },
  "model/u3d": {
    "source": "iana",
    "extensions": [
      "u3d"
    ]
  },
  "model/vnd.bary": {
    "source": "iana",
    "extensions": [
      "bary"
    ]
  },
  "model/vnd.cld": {
    "source": "iana",
    "extensions": [
      "cld"
    ]
  },
  "model/vnd.collada+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "dae"
    ]
  },
  "model/vnd.dwf": {
    "source": "iana",
    "extensions": [
      "dwf"
    ]
  },
  "model/vnd.flatland.3dml": {
    "source": "iana"
  },
  "model/vnd.gdl": {
    "source": "iana",
    "extensions": [
      "gdl"
    ]
  },
  "model/vnd.gs-gdl": {
    "source": "apache"
  },
  "model/vnd.gs.gdl": {
    "source": "iana"
  },
  "model/vnd.gtw": {
    "source": "iana",
    "extensions": [
      "gtw"
    ]
  },
  "model/vnd.moml+xml": {
    "source": "iana",
    "compressible": true
  },
  "model/vnd.mts": {
    "source": "iana",
    "extensions": [
      "mts"
    ]
  },
  "model/vnd.opengex": {
    "source": "iana",
    "extensions": [
      "ogex"
    ]
  },
  "model/vnd.parasolid.transmit.binary": {
    "source": "iana",
    "extensions": [
      "x_b"
    ]
  },
  "model/vnd.parasolid.transmit.text": {
    "source": "iana",
    "extensions": [
      "x_t"
    ]
  },
  "model/vnd.pytha.pyox": {
    "source": "iana",
    "extensions": [
      "pyo",
      "pyox"
    ]
  },
  "model/vnd.rosette.annotated-data-model": {
    "source": "iana"
  },
  "model/vnd.sap.vds": {
    "source": "iana",
    "extensions": [
      "vds"
    ]
  },
  "model/vnd.usda": {
    "source": "iana",
    "extensions": [
      "usda"
    ]
  },
  "model/vnd.usdz+zip": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "usdz"
    ]
  },
  "model/vnd.valve.source.compiled-map": {
    "source": "iana",
    "extensions": [
      "bsp"
    ]
  },
  "model/vnd.vtu": {
    "source": "iana",
    "extensions": [
      "vtu"
    ]
  },
  "model/vrml": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "wrl",
      "vrml"
    ]
  },
  "model/x3d+binary": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "x3db",
      "x3dbz"
    ]
  },
  "model/x3d+fastinfoset": {
    "source": "iana",
    "extensions": [
      "x3db"
    ]
  },
  "model/x3d+vrml": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "x3dv",
      "x3dvz"
    ]
  },
  "model/x3d+xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "x3d",
      "x3dz"
    ]
  },
  "model/x3d-vrml": {
    "source": "iana",
    "extensions": [
      "x3dv"
    ]
  },
  "multipart/alternative": {
    "source": "iana",
    "compressible": false
  },
  "multipart/appledouble": {
    "source": "iana"
  },
  "multipart/byteranges": {
    "source": "iana"
  },
  "multipart/digest": {
    "source": "iana"
  },
  "multipart/encrypted": {
    "source": "iana",
    "compressible": false
  },
  "multipart/form-data": {
    "source": "iana",
    "compressible": false
  },
  "multipart/header-set": {
    "source": "iana"
  },
  "multipart/mixed": {
    "source": "iana"
  },
  "multipart/multilingual": {
    "source": "iana"
  },
  "multipart/parallel": {
    "source": "iana"
  },
  "multipart/related": {
    "source": "iana",
    "compressible": false
  },
  "multipart/report": {
    "source": "iana"
  },
  "multipart/signed": {
    "source": "iana",
    "compressible": false
  },
  "multipart/vnd.bint.med-plus": {
    "source": "iana"
  },
  "multipart/voice-message": {
    "source": "iana"
  },
  "multipart/x-mixed-replace": {
    "source": "iana"
  },
  "text/1d-interleaved-parityfec": {
    "source": "iana"
  },
  "text/cache-manifest": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "appcache",
      "manifest"
    ]
  },
  "text/calendar": {
    "source": "iana",
    "extensions": [
      "ics",
      "ifb"
    ]
  },
  "text/calender": {
    "compressible": true
  },
  "text/cmd": {
    "compressible": true
  },
  "text/coffeescript": {
    "extensions": [
      "coffee",
      "litcoffee"
    ]
  },
  "text/cql": {
    "source": "iana"
  },
  "text/cql-expression": {
    "source": "iana"
  },
  "text/cql-identifier": {
    "source": "iana"
  },
  "text/css": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "css"
    ]
  },
  "text/csv": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "csv"
    ]
  },
  "text/csv-schema": {
    "source": "iana"
  },
  "text/directory": {
    "source": "iana"
  },
  "text/dns": {
    "source": "iana"
  },
  "text/ecmascript": {
    "source": "apache"
  },
  "text/encaprtp": {
    "source": "iana"
  },
  "text/enriched": {
    "source": "iana"
  },
  "text/fhirpath": {
    "source": "iana"
  },
  "text/flexfec": {
    "source": "iana"
  },
  "text/fwdred": {
    "source": "iana"
  },
  "text/gff3": {
    "source": "iana"
  },
  "text/grammar-ref-list": {
    "source": "iana"
  },
  "text/hl7v2": {
    "source": "iana"
  },
  "text/html": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "html",
      "htm",
      "shtml"
    ]
  },
  "text/jade": {
    "extensions": [
      "jade"
    ]
  },
  "text/javascript": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "js",
      "mjs"
    ]
  },
  "text/jcr-cnd": {
    "source": "iana"
  },
  "text/jsx": {
    "compressible": true,
    "extensions": [
      "jsx"
    ]
  },
  "text/less": {
    "compressible": true,
    "extensions": [
      "less"
    ]
  },
  "text/markdown": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "md",
      "markdown"
    ]
  },
  "text/mathml": {
    "source": "nginx",
    "extensions": [
      "mml"
    ]
  },
  "text/mdx": {
    "compressible": true,
    "extensions": [
      "mdx"
    ]
  },
  "text/mizar": {
    "source": "iana"
  },
  "text/n3": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "n3"
    ]
  },
  "text/parameters": {
    "source": "iana",
    "charset": "UTF-8"
  },
  "text/parityfec": {
    "source": "iana"
  },
  "text/plain": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "txt",
      "text",
      "conf",
      "def",
      "list",
      "log",
      "in",
      "ini"
    ]
  },
  "text/provenance-notation": {
    "source": "iana",
    "charset": "UTF-8"
  },
  "text/prs.fallenstein.rst": {
    "source": "iana"
  },
  "text/prs.lines.tag": {
    "source": "iana",
    "extensions": [
      "dsc"
    ]
  },
  "text/prs.prop.logic": {
    "source": "iana"
  },
  "text/prs.texi": {
    "source": "iana"
  },
  "text/raptorfec": {
    "source": "iana"
  },
  "text/red": {
    "source": "iana"
  },
  "text/rfc822-headers": {
    "source": "iana"
  },
  "text/richtext": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rtx"
    ]
  },
  "text/rtf": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "rtf"
    ]
  },
  "text/rtp-enc-aescm128": {
    "source": "iana"
  },
  "text/rtploopback": {
    "source": "iana"
  },
  "text/rtx": {
    "source": "iana"
  },
  "text/sgml": {
    "source": "iana",
    "extensions": [
      "sgml",
      "sgm"
    ]
  },
  "text/shaclc": {
    "source": "iana"
  },
  "text/shex": {
    "source": "iana",
    "extensions": [
      "shex"
    ]
  },
  "text/slim": {
    "extensions": [
      "slim",
      "slm"
    ]
  },
  "text/spdx": {
    "source": "iana",
    "extensions": [
      "spdx"
    ]
  },
  "text/strings": {
    "source": "iana"
  },
  "text/stylus": {
    "extensions": [
      "stylus",
      "styl"
    ]
  },
  "text/t140": {
    "source": "iana"
  },
  "text/tab-separated-values": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "tsv"
    ]
  },
  "text/troff": {
    "source": "iana",
    "extensions": [
      "t",
      "tr",
      "roff",
      "man",
      "me",
      "ms"
    ]
  },
  "text/turtle": {
    "source": "iana",
    "charset": "UTF-8",
    "extensions": [
      "ttl"
    ]
  },
  "text/ulpfec": {
    "source": "iana"
  },
  "text/uri-list": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "uri",
      "uris",
      "urls"
    ]
  },
  "text/vcard": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "vcard"
    ]
  },
  "text/vnd.a": {
    "source": "iana"
  },
  "text/vnd.abc": {
    "source": "iana"
  },
  "text/vnd.ascii-art": {
    "source": "iana"
  },
  "text/vnd.curl": {
    "source": "iana",
    "extensions": [
      "curl"
    ]
  },
  "text/vnd.curl.dcurl": {
    "source": "apache",
    "extensions": [
      "dcurl"
    ]
  },
  "text/vnd.curl.mcurl": {
    "source": "apache",
    "extensions": [
      "mcurl"
    ]
  },
  "text/vnd.curl.scurl": {
    "source": "apache",
    "extensions": [
      "scurl"
    ]
  },
  "text/vnd.debian.copyright": {
    "source": "iana",
    "charset": "UTF-8"
  },
  "text/vnd.dmclientscript": {
    "source": "iana"
  },
  "text/vnd.dvb.subtitle": {
    "source": "iana",
    "extensions": [
      "sub"
    ]
  },
  "text/vnd.esmertec.theme-descriptor": {
    "source": "iana",
    "charset": "UTF-8"
  },
  "text/vnd.exchangeable": {
    "source": "iana"
  },
  "text/vnd.familysearch.gedcom": {
    "source": "iana",
    "extensions": [
      "ged"
    ]
  },
  "text/vnd.ficlab.flt": {
    "source": "iana"
  },
  "text/vnd.fly": {
    "source": "iana",
    "extensions": [
      "fly"
    ]
  },
  "text/vnd.fmi.flexstor": {
    "source": "iana",
    "extensions": [
      "flx"
    ]
  },
  "text/vnd.gml": {
    "source": "iana"
  },
  "text/vnd.graphviz": {
    "source": "iana",
    "extensions": [
      "gv"
    ]
  },
  "text/vnd.hans": {
    "source": "iana"
  },
  "text/vnd.hgl": {
    "source": "iana"
  },
  "text/vnd.in3d.3dml": {
    "source": "iana",
    "extensions": [
      "3dml"
    ]
  },
  "text/vnd.in3d.spot": {
    "source": "iana",
    "extensions": [
      "spot"
    ]
  },
  "text/vnd.iptc.newsml": {
    "source": "iana"
  },
  "text/vnd.iptc.nitf": {
    "source": "iana"
  },
  "text/vnd.latex-z": {
    "source": "iana"
  },
  "text/vnd.motorola.reflex": {
    "source": "iana"
  },
  "text/vnd.ms-mediapackage": {
    "source": "iana"
  },
  "text/vnd.net2phone.commcenter.command": {
    "source": "iana"
  },
  "text/vnd.radisys.msml-basic-layout": {
    "source": "iana"
  },
  "text/vnd.senx.warpscript": {
    "source": "iana"
  },
  "text/vnd.si.uricatalogue": {
    "source": "apache"
  },
  "text/vnd.sosi": {
    "source": "iana"
  },
  "text/vnd.sun.j2me.app-descriptor": {
    "source": "iana",
    "charset": "UTF-8",
    "extensions": [
      "jad"
    ]
  },
  "text/vnd.trolltech.linguist": {
    "source": "iana",
    "charset": "UTF-8"
  },
  "text/vnd.vcf": {
    "source": "iana"
  },
  "text/vnd.wap.si": {
    "source": "iana"
  },
  "text/vnd.wap.sl": {
    "source": "iana"
  },
  "text/vnd.wap.wml": {
    "source": "iana",
    "extensions": [
      "wml"
    ]
  },
  "text/vnd.wap.wmlscript": {
    "source": "iana",
    "extensions": [
      "wmls"
    ]
  },
  "text/vnd.zoo.kcl": {
    "source": "iana"
  },
  "text/vtt": {
    "source": "iana",
    "charset": "UTF-8",
    "compressible": true,
    "extensions": [
      "vtt"
    ]
  },
  "text/wgsl": {
    "source": "iana",
    "extensions": [
      "wgsl"
    ]
  },
  "text/x-asm": {
    "source": "apache",
    "extensions": [
      "s",
      "asm"
    ]
  },
  "text/x-c": {
    "source": "apache",
    "extensions": [
      "c",
      "cc",
      "cxx",
      "cpp",
      "h",
      "hh",
      "dic"
    ]
  },
  "text/x-component": {
    "source": "nginx",
    "extensions": [
      "htc"
    ]
  },
  "text/x-fortran": {
    "source": "apache",
    "extensions": [
      "f",
      "for",
      "f77",
      "f90"
    ]
  },
  "text/x-gwt-rpc": {
    "compressible": true
  },
  "text/x-handlebars-template": {
    "extensions": [
      "hbs"
    ]
  },
  "text/x-java-source": {
    "source": "apache",
    "extensions": [
      "java"
    ]
  },
  "text/x-jquery-tmpl": {
    "compressible": true
  },
  "text/x-lua": {
    "extensions": [
      "lua"
    ]
  },
  "text/x-markdown": {
    "compressible": true,
    "extensions": [
      "mkd"
    ]
  },
  "text/x-nfo": {
    "source": "apache",
    "extensions": [
      "nfo"
    ]
  },
  "text/x-opml": {
    "source": "apache",
    "extensions": [
      "opml"
    ]
  },
  "text/x-org": {
    "compressible": true,
    "extensions": [
      "org"
    ]
  },
  "text/x-pascal": {
    "source": "apache",
    "extensions": [
      "p",
      "pas"
    ]
  },
  "text/x-processing": {
    "compressible": true,
    "extensions": [
      "pde"
    ]
  },
  "text/x-sass": {
    "extensions": [
      "sass"
    ]
  },
  "text/x-scss": {
    "extensions": [
      "scss"
    ]
  },
  "text/x-setext": {
    "source": "apache",
    "extensions": [
      "etx"
    ]
  },
  "text/x-sfv": {
    "source": "apache",
    "extensions": [
      "sfv"
    ]
  },
  "text/x-suse-ymp": {
    "compressible": true,
    "extensions": [
      "ymp"
    ]
  },
  "text/x-uuencode": {
    "source": "apache",
    "extensions": [
      "uu"
    ]
  },
  "text/x-vcalendar": {
    "source": "apache",
    "extensions": [
      "vcs"
    ]
  },
  "text/x-vcard": {
    "source": "apache",
    "extensions": [
      "vcf"
    ]
  },
  "text/xml": {
    "source": "iana",
    "compressible": true,
    "extensions": [
      "xml"
    ]
  },
  "text/xml-external-parsed-entity": {
    "source": "iana"
  },
  "text/yaml": {
    "compressible": true,
    "extensions": [
      "yaml",
      "yml"
    ]
  },
  "video/1d-interleaved-parityfec": {
    "source": "iana"
  },
  "video/3gpp": {
    "source": "iana",
    "extensions": [
      "3gp",
      "3gpp"
    ]
  },
  "video/3gpp-tt": {
    "source": "iana"
  },
  "video/3gpp2": {
    "source": "iana",
    "extensions": [
      "3g2"
    ]
  },
  "video/av1": {
    "source": "iana"
  },
  "video/bmpeg": {
    "source": "iana"
  },
  "video/bt656": {
    "source": "iana"
  },
  "video/celb": {
    "source": "iana"
  },
  "video/dv": {
    "source": "iana"
  },
  "video/encaprtp": {
    "source": "iana"
  },
  "video/evc": {
    "source": "iana"
  },
  "video/ffv1": {
    "source": "iana"
  },
  "video/flexfec": {
    "source": "iana"
  },
  "video/h261": {
    "source": "iana",
    "extensions": [
      "h261"
    ]
  },
  "video/h263": {
    "source": "iana",
    "extensions": [
      "h263"
    ]
  },
  "video/h263-1998": {
    "source": "iana"
  },
  "video/h263-2000": {
    "source": "iana"
  },
  "video/h264": {
    "source": "iana",
    "extensions": [
      "h264"
    ]
  },
  "video/h264-rcdo": {
    "source": "iana"
  },
  "video/h264-svc": {
    "source": "iana"
  },
  "video/h265": {
    "source": "iana"
  },
  "video/h266": {
    "source": "iana"
  },
  "video/iso.segment": {
    "source": "iana",
    "extensions": [
      "m4s"
    ]
  },
  "video/jpeg": {
    "source": "iana",
    "extensions": [
      "jpgv"
    ]
  },
  "video/jpeg2000": {
    "source": "iana"
  },
  "video/jpm": {
    "source": "apache",
    "extensions": [
      "jpm",
      "jpgm"
    ]
  },
  "video/jxsv": {
    "source": "iana"
  },
  "video/matroska": {
    "source": "iana"
  },
  "video/matroska-3d": {
    "source": "iana"
  },
  "video/mj2": {
    "source": "iana",
    "extensions": [
      "mj2",
      "mjp2"
    ]
  },
  "video/mp1s": {
    "source": "iana"
  },
  "video/mp2p": {
    "source": "iana"
  },
  "video/mp2t": {
    "source": "iana",
    "extensions": [
      "ts",
      "m2t",
      "m2ts",
      "mts"
    ]
  },
  "video/mp4": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "mp4",
      "mp4v",
      "mpg4"
    ]
  },
  "video/mp4v-es": {
    "source": "iana"
  },
  "video/mpeg": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "mpeg",
      "mpg",
      "mpe",
      "m1v",
      "m2v"
    ]
  },
  "video/mpeg4-generic": {
    "source": "iana"
  },
  "video/mpv": {
    "source": "iana"
  },
  "video/nv": {
    "source": "iana"
  },
  "video/ogg": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "ogv"
    ]
  },
  "video/parityfec": {
    "source": "iana"
  },
  "video/pointer": {
    "source": "iana"
  },
  "video/quicktime": {
    "source": "iana",
    "compressible": false,
    "extensions": [
      "qt",
      "mov"
    ]
  },
  "video/raptorfec": {
    "source": "iana"
  },
  "video/raw": {
    "source": "iana"
  },
  "video/rtp-enc-aescm128": {
    "source": "iana"
  },
  "video/rtploopback": {
    "source": "iana"
  },
  "video/rtx": {
    "source": "iana"
  },
  "video/scip": {
    "source": "iana"
  },
  "video/smpte291": {
    "source": "iana"
  },
  "video/smpte292m": {
    "source": "iana"
  },
  "video/ulpfec": {
    "source": "iana"
  },
  "video/vc1": {
    "source": "iana"
  },
  "video/vc2": {
    "source": "iana"
  },
  "video/vnd.cctv": {
    "source": "iana"
  },
  "video/vnd.dece.hd": {
    "source": "iana",
    "extensions": [
      "uvh",
      "uvvh"
    ]
  },
  "video/vnd.dece.mobile": {
    "source": "iana",
    "extensions": [
      "uvm",
      "uvvm"
    ]
  },
  "video/vnd.dece.mp4": {
    "source": "iana"
  },
  "video/vnd.dece.pd": {
    "source": "iana",
    "extensions": [
      "uvp",
      "uvvp"
    ]
  },
  "video/vnd.dece.sd": {
    "source": "iana",
    "extensions": [
      "uvs",
      "uvvs"
    ]
  },
  "video/vnd.dece.video": {
    "source": "iana",
    "extensions": [
      "uvv",
      "uvvv"
    ]
  },
  "video/vnd.directv.mpeg": {
    "source": "iana"
  },
  "video/vnd.directv.mpeg-tts": {
    "source": "iana"
  },
  "video/vnd.dlna.mpeg-tts": {
    "source": "iana"
  },
  "video/vnd.dvb.file": {
    "source": "iana",
    "extensions": [
      "dvb"
    ]
  },
  "video/vnd.fvt": {
    "source": "iana",
    "extensions": [
      "fvt"
    ]
  },
  "video/vnd.hns.video": {
    "source": "iana"
  },
  "video/vnd.iptvforum.1dparityfec-1010": {
    "source": "iana"
  },
  "video/vnd.iptvforum.1dparityfec-2005": {
    "source": "iana"
  },
  "video/vnd.iptvforum.2dparityfec-1010": {
    "source": "iana"
  },
  "video/vnd.iptvforum.2dparityfec-2005": {
    "source": "iana"
  },
  "video/vnd.iptvforum.ttsavc": {
    "source": "iana"
  },
  "video/vnd.iptvforum.ttsmpeg2": {
    "source": "iana"
  },
  "video/vnd.motorola.video": {
    "source": "iana"
  },
  "video/vnd.motorola.videop": {
    "source": "iana"
  },
  "video/vnd.mpegurl": {
    "source": "iana",
    "extensions": [
      "mxu",
      "m4u"
    ]
  },
  "video/vnd.ms-playready.media.pyv": {
    "source": "iana",
    "extensions": [
      "pyv"
    ]
  },
  "video/vnd.nokia.interleaved-multimedia": {
    "source": "iana"
  },
  "video/vnd.nokia.mp4vr": {
    "source": "iana"
  },
  "video/vnd.nokia.videovoip": {
    "source": "iana"
  },
  "video/vnd.objectvideo": {
    "source": "iana"
  },
  "video/vnd.radgamettools.bink": {
    "source": "iana"
  },
  "video/vnd.radgamettools.smacker": {
    "source": "apache"
  },
  "video/vnd.sealed.mpeg1": {
    "source": "iana"
  },
  "video/vnd.sealed.mpeg4": {
    "source": "iana"
  },
  "video/vnd.sealed.swf": {
    "source": "iana"
  },
  "video/vnd.sealedmedia.softseal.mov": {
    "source": "iana"
  },
  "video/vnd.uvvu.mp4": {
    "source": "iana",
    "extensions": [
      "uvu",
      "uvvu"
    ]
  },
  "video/vnd.vivo": {
    "source": "iana",
    "extensions": [
      "viv"
    ]
  },
  "video/vnd.youtube.yt": {
    "source": "iana"
  },
  "video/vp8": {
    "source": "iana"
  },
  "video/vp9": {
    "source": "iana"
  },
  "video/webm": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "webm"
    ]
  },
  "video/x-f4v": {
    "source": "apache",
    "extensions": [
      "f4v"
    ]
  },
  "video/x-fli": {
    "source": "apache",
    "extensions": [
      "fli"
    ]
  },
  "video/x-flv": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "flv"
    ]
  },
  "video/x-m4v": {
    "source": "apache",
    "extensions": [
      "m4v"
    ]
  },
  "video/x-matroska": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "mkv",
      "mk3d",
      "mks"
    ]
  },
  "video/x-mng": {
    "source": "apache",
    "extensions": [
      "mng"
    ]
  },
  "video/x-ms-asf": {
    "source": "apache",
    "extensions": [
      "asf",
      "asx"
    ]
  },
  "video/x-ms-vob": {
    "source": "apache",
    "extensions": [
      "vob"
    ]
  },
  "video/x-ms-wm": {
    "source": "apache",
    "extensions": [
      "wm"
    ]
  },
  "video/x-ms-wmv": {
    "source": "apache",
    "compressible": false,
    "extensions": [
      "wmv"
    ]
  },
  "video/x-ms-wmx": {
    "source": "apache",
    "extensions": [
      "wmx"
    ]
  },
  "video/x-ms-wvx": {
    "source": "apache",
    "extensions": [
      "wvx"
    ]
  },
  "video/x-msvideo": {
    "source": "apache",
    "extensions": [
      "avi"
    ]
  },
  "video/x-sgi-movie": {
    "source": "apache",
    "extensions": [
      "movie"
    ]
  },
  "video/x-smv": {
    "source": "apache",
    "extensions": [
      "smv"
    ]
  },
  "x-conference/x-cooltalk": {
    "source": "apache",
    "extensions": [
      "ice"
    ]
  },
  "x-shader/x-fragment": {
    "compressible": true
  },
  "x-shader/x-vertex": {
    "compressible": true
  }
};

// deno:https://jsr.io/@std/media-types/1.1.0/_db.ts
var types = /* @__PURE__ */ new Map();
var extensions = /* @__PURE__ */ new Map();
var preference = [
  "nginx",
  "apache",
  void 0,
  "iana"
];
for (const type of Object.keys(db_default)) {
  const mime = db_default[type];
  const exts = mime.extensions;
  if (!exts || !exts.length) {
    continue;
  }
  extensions.set(type, exts);
  for (const ext of exts) {
    const current = types.get(ext);
    if (current) {
      const from = preference.indexOf(db_default[current].source);
      const to = preference.indexOf(mime.source);
      if (current !== "application/octet-stream" && current !== "application/mp4" && (from > to || // @ts-ignore work around https://github.com/denoland/dnt/issues/148
      from === to && current.startsWith("application/"))) {
        continue;
      }
    }
    types.set(ext, type);
  }
}

// deno:https://jsr.io/@std/internal/1.0.14/_os.ts
function checkWindows() {
  const global = globalThis;
  const platform = global.process?.platform;
  if (typeof platform === "string") return platform.startsWith("win");
  const os = global.Deno?.build?.os;
  if (typeof os === "string") return os === "windows";
  return global.navigator?.platform?.startsWith("Win") ?? false;
}

// deno:https://jsr.io/@std/internal/1.0.14/os.ts
var isWindows = checkWindows();

// src/blossom-upload.ts
var UPLOAD_AUTH_KIND = 24242;
var UPLOAD_AUTH_TTL_SECONDS = 3600;
async function uploadFilesToServers(files, servers, signer, options = {}) {
  const fetcher = options.fetch ?? fetch;
  const blobSha256s = [
    ...new Set(files.map((file) => file.sha256))
  ];
  const results = [];
  const totalUploads = files.length * servers.length;
  for (const server of servers) {
    const authAttempts = [
      {
        create: once(() => createUploadAuthorization(signer, blobSha256s, options.now, serverHost(server)))
      },
      {
        create: once(() => createUploadAuthorization(signer, blobSha256s, options.now))
      },
      {
        create: once(() => createUploadAuthorization(signer, blobSha256s, options.now, void 0, "base64"))
      }
    ];
    let preferredAuthAttempt = 0;
    for (const file of files) {
      const upload = await uploadFileToServer(file, server, authAttempts, fetcher, preferredAuthAttempt);
      const result = upload.result;
      if (upload.authAttemptIndex !== void 0) preferredAuthAttempt = upload.authAttemptIndex;
      results.push(result);
      options.onProgress?.({
        type: "upload:result",
        completedUploads: results.length,
        totalUploads,
        result
      });
    }
  }
  return results;
}
async function createUploadAuthorization(signer, blobSha256s, now = () => Math.floor(Date.now() / 1e3), server, encoding = "base64url") {
  const createdAt = now();
  const tags = [
    [
      "t",
      "upload"
    ],
    ...blobSha256s.map((hash) => [
      "x",
      hash
    ]),
    [
      "expiration",
      String(createdAt + UPLOAD_AUTH_TTL_SECONDS)
    ],
    [
      "client",
      "napplet"
    ]
  ];
  if (server) tags.push([
    "server",
    server
  ]);
  const signed = await signer.sign({
    kind: UPLOAD_AUTH_KIND,
    created_at: createdAt,
    tags,
    content: "Upload blobs via napplet"
  });
  return `Nostr ${encodeAuthEvent(signed, encoding)}`;
}
async function uploadFileToServer(file, server, authAttempts, fetcher, preferredAuthAttempt) {
  const base = server.endsWith("/") ? server : `${server}/`;
  const blobUrl = `${base}${file.sha256}`;
  const uploadUrl = `${base}upload`;
  try {
    const preflight = await fetcher(blobUrl, {
      method: "HEAD"
    });
    if (preflight.ok) {
      return {
        result: {
          server,
          file: file.path,
          sha256: file.sha256,
          success: true,
          skipped: true
        }
      };
    }
  } catch {
  }
  let lastFailure;
  for (const { authAttempt, index } of orderedAuthAttempts(authAttempts, preferredAuthAttempt)) {
    const result = await putFileToServer(file, server, uploadUrl, await authAttempt.create(), fetcher);
    if (result.success) return {
      result,
      authAttemptIndex: index
    };
    lastFailure = result;
    if (!isRetryableAuthFailure(result)) return {
      result
    };
  }
  return {
    result: lastFailure ?? failure(server, file, `PUT ${uploadUrl} did not run`)
  };
}
async function putFileToServer(file, server, uploadUrl, authHeader, fetcher) {
  const response = await fetcher(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": file.contentType,
      // BUD-02: lets the server reject a mismatched body early (409) before storing it.
      "X-SHA-256": file.sha256
    },
    body: new Blob([
      copyBytes2(file.data).buffer
    ], {
      type: file.contentType
    })
  });
  if (!response.ok) {
    const reason = response.headers.get("x-reason");
    const body = await response.text().catch(() => "");
    const details = [
      reason,
      body
    ].filter(Boolean).join(": ");
    return failure(server, file, `PUT ${uploadUrl} returned HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }
  const descriptorError = await verifyBlobDescriptor(response, file.sha256);
  if (descriptorError) return failure(server, file, `PUT ${uploadUrl} ${descriptorError}`);
  return {
    server,
    file: file.path,
    sha256: file.sha256,
    success: true,
    skipped: false
  };
}
function isRetryableAuthFailure(result) {
  if (result.success) return false;
  const error = result.error ?? "";
  if (!/\bHTTP (400|401)\b/.test(error)) return false;
  return /auth|authorization|token|server url mismatch|server .*scope|invalid auth string|signature|base64/i.test(error);
}
function orderedAuthAttempts(attempts, preferredIndex) {
  return attempts.map((authAttempt, index) => ({
    authAttempt,
    index
  })).sort((left, right) => {
    if (left.index === preferredIndex) return -1;
    if (right.index === preferredIndex) return 1;
    return left.index - right.index;
  });
}
async function verifyBlobDescriptor(response, expectedSha256) {
  let descriptor;
  try {
    descriptor = await response.json();
  } catch {
    return "returned an unparseable blob descriptor";
  }
  if (typeof descriptor !== "object" || descriptor === null) {
    return "returned an invalid blob descriptor";
  }
  const sha2562 = descriptor.sha256;
  if (typeof sha2562 !== "string") return "blob descriptor is missing a sha256";
  if (sha2562.toLowerCase() !== expectedSha256) {
    return `stored sha256 ${sha2562} does not match expected ${expectedSha256}`;
  }
  return void 0;
}
function failure(server, file, error) {
  return {
    server,
    file: file.path,
    sha256: file.sha256,
    success: false,
    skipped: false,
    error
  };
}
function copyBytes2(bytes) {
  return new Uint8Array(bytes);
}
function encodeAuthEvent(event, encoding) {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  if (encoding === "base64url") return base64urlnopad.encode(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function once(create) {
  let promise;
  return () => {
    promise ??= create();
    return promise;
  };
}
function serverHost(server) {
  try {
    return new URL(server).hostname.toLowerCase();
  } catch {
    return server.split(":")[0].toLowerCase();
  }
}

// src/deploy-network.ts
async function publishEventWithSimplePool(relays, event) {
  const pool = new SimplePool();
  try {
    const settled = await Promise.allSettled(pool.publish(relays, event, {
      maxWait: 15e3
    }));
    return relays.map((relay, index) => {
      const result = settled[index];
      if (result?.status === "fulfilled") {
        return {
          relay,
          eventId: event.id,
          success: true
        };
      }
      const reason = result?.status === "rejected" ? result.reason : "publish did not run";
      return {
        relay,
        eventId: event.id,
        success: false,
        error: reason instanceof Error ? reason.message : String(reason)
      };
    });
  } finally {
    pool.close(relays);
    pool.destroy();
  }
}
export {
  publishEventWithSimplePool,
  uploadFilesToServers
};
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
