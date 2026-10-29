// Minimal protobuf encoding: only what the Android TV remote messages need.

import { concatBytes, utf8Decode, utf8Encode } from './bytes';

export function encodeVarint(value: number): number[] {
  if (value < 0 || !Number.isSafeInteger(value)) {
    throw new Error(`varint out of range: ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** Reads a varint. Returns null when the buffer ends before the varint does. */
export function decodeVarint(buf: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let multiplier = 1;
  let pos = start;
  while (pos < buf.length) {
    const b = buf[pos++];
    value += (b & 0x7f) * multiplier;
    if ((b & 0x80) === 0) return { value, next: pos };
    multiplier *= 128;
    if (pos - start > 10) throw new Error('varint too long');
  }
  return null;
}

export class PbWriter {
  private parts: number[] = [];

  private tag(field: number, wireType: number) {
    this.parts.push(...encodeVarint(field * 8 + wireType));
  }

  /** Unsigned/positive integer field. Skipped when undefined. */
  uint(field: number, value: number | undefined): this {
    if (value === undefined) return this;
    this.tag(field, 0);
    this.parts.push(...encodeVarint(value));
    return this;
  }

  bool(field: number, value: boolean | undefined): this {
    return value === undefined ? this : this.uint(field, value ? 1 : 0);
  }

  bytes(field: number, value: Uint8Array | undefined): this {
    if (value === undefined) return this;
    this.tag(field, 2);
    this.parts.push(...encodeVarint(value.length));
    for (const b of value) this.parts.push(b);
    return this;
  }

  string(field: number, value: string | undefined): this {
    return value === undefined ? this : this.bytes(field, utf8Encode(value));
  }

  message(field: number, value: PbWriter): this {
    return this.bytes(field, value.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

type RawField = { wireType: number; num: number; bytes: Uint8Array };

/** Parsed view of one protobuf message. Unknown fields are kept but ignored. */
export class PbMessage {
  private fields = new Map<number, RawField[]>();

  constructor(buf: Uint8Array) {
    let pos = 0;
    while (pos < buf.length) {
      const key = decodeVarint(buf, pos);
      if (!key) throw new Error('truncated field key');
      pos = key.next;
      const field = Math.floor(key.value / 8);
      const wireType = key.value % 8;
      let raw: RawField;
      if (wireType === 0) {
        const v = decodeVarint(buf, pos);
        if (!v) throw new Error('truncated varint');
        pos = v.next;
        raw = { wireType, num: v.value, bytes: new Uint8Array(0) };
      } else if (wireType === 2) {
        const len = decodeVarint(buf, pos);
        if (!len) throw new Error('truncated length');
        const end = len.next + len.value;
        if (end > buf.length) throw new Error('truncated bytes');
        raw = { wireType, num: 0, bytes: buf.subarray(len.next, end) };
        pos = end;
      } else if (wireType === 1) {
        raw = { wireType, num: 0, bytes: buf.subarray(pos, pos + 8) };
        pos += 8;
      } else if (wireType === 5) {
        raw = { wireType, num: 0, bytes: buf.subarray(pos, pos + 4) };
        pos += 4;
      } else {
        throw new Error(`unsupported wire type ${wireType}`);
      }
      const list = this.fields.get(field) ?? [];
      list.push(raw);
      this.fields.set(field, list);
    }
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  fieldNumbers(): number[] {
    return [...this.fields.keys()];
  }

  num(field: number, fallback = 0): number {
    const list = this.fields.get(field);
    return list ? list[list.length - 1].num : fallback;
  }

  bytes(field: number): Uint8Array {
    const list = this.fields.get(field);
    return list ? list[list.length - 1].bytes : new Uint8Array(0);
  }

  str(field: number): string {
    return utf8Decode(this.bytes(field));
  }

  msg(field: number): PbMessage {
    return new PbMessage(this.bytes(field));
  }

  msgs(field: number): PbMessage[] {
    return (this.fields.get(field) ?? []).map((f) => new PbMessage(f.bytes));
  }
}

/** Length-prefixes a message the way the TV expects (varint length, then bytes). */
export function frame(message: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.from(encodeVarint(message.length)), message);
}

/** Splits a TCP byte stream into length-prefixed messages. */
export class Deframer {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = this.buf.length ? concatBytes(this.buf, chunk) : chunk.slice();
    const out: Uint8Array[] = [];
    for (;;) {
      const len = decodeVarint(this.buf, 0);
      if (!len) break;
      const end = len.next + len.value;
      if (this.buf.length < end) break;
      out.push(this.buf.slice(len.next, end));
      this.buf = this.buf.slice(end);
    }
    return out;
  }
}
