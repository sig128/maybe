import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/** Values that don't fit their field are refused, never wrapped (a wrapped -1 is an unlimited u64 cap). */
function checkRange(kind: string, v: bigint, min: bigint, max: bigint): bigint {
  if (v < min || v > max) throw new RangeError(`${kind} out of range: ${v}`);
  return v;
}

/** Minimal little-endian Borsh writer/reader for instruction args and accounts. */
export class Writer {
  private parts: Uint8Array[] = [];
  u8(v: number) {
    this.parts.push(Uint8Array.of(Number(checkRange("u8", BigInt(v), 0n, 0xffn))));
    return this;
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, Number(checkRange("u16", BigInt(v), 0n, 0xffffn)), true);
    this.parts.push(b);
    return this;
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, Number(checkRange("u32", BigInt(v), 0n, 0xffff_ffffn)), true);
    this.parts.push(b);
    return this;
  }
  u64(v: bigint | number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, checkRange("u64", BigInt(v), 0n, 2n ** 64n - 1n), true);
    this.parts.push(b);
    return this;
  }
  i64(v: bigint | number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, checkRange("i64", BigInt(v), -(2n ** 63n), 2n ** 63n - 1n), true);
    this.parts.push(b);
    return this;
  }
  fixed(bytes: Uint8Array) {
    this.parts.push(bytes);
    return this;
  }
  pubkey(k: PublicKey) {
    return this.fixed(k.toBytes());
  }
  bytes(b: Uint8Array) {
    this.u32(b.length);
    return this.fixed(b);
  }
  vec<T>(items: T[], f: (w: Writer, x: T) => void) {
    this.u32(items.length);
    for (const x of items) f(this, x);
    return this;
  }
  done(): Buffer {
    const len = this.parts.reduce((m, p) => m + p.length, 0);
    const out = Buffer.alloc(len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export class Reader {
  private dv: DataView;
  constructor(
    public buf: Uint8Array,
    public off = 0,
  ) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  at(off: number) {
    return new Reader(this.buf, off);
  }
  u8() {
    return this.dv.getUint8(this.off++);
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.dv.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  u64() {
    const v = this.dv.getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }
  i64() {
    const v = this.dv.getBigInt64(this.off, true);
    this.off += 8;
    return v;
  }
  fixed(n: number) {
    const v = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return v;
  }
  pubkey() {
    return new PublicKey(this.fixed(32));
  }
}

const cache = new Map<string, Buffer>();
function prefix(kind: string, name: string): Buffer {
  const k = `${kind}:${name}`;
  let v = cache.get(k);
  if (!v) {
    v = Buffer.from(sha256(utf8ToBytes(k)).slice(0, 8));
    cache.set(k, v);
  }
  return v;
}

/** Anchor discriminators: sha256("global:<ix>"), sha256("account:<Name>"), sha256("event:<Name>"). */
export const ixDisc = (name: string) => prefix("global", name);
export const accountDisc = (name: string) => prefix("account", name);
export const eventDisc = (name: string) => prefix("event", name);

export function hasDisc(data: Uint8Array, disc: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

export const NO_TIME = -(2n ** 63n);
export function optTime(v: bigint): number | null {
  return v === NO_TIME ? null : Number(v);
}
