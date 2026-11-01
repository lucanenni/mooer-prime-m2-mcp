// Wire framing: aa 55 | len (u16 LE) | payload | CRC-16/GSM (BE) over len+payload.

export const SYNC = [0xaa, 0x55] as const;

export function crc16(data: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc ^ 0xffff;
}

export function encode(payload: ArrayLike<number>): Uint8Array {
  const n = payload.length;
  const out = new Uint8Array(n + 6);
  out[0] = SYNC[0];
  out[1] = SYNC[1];
  out[2] = n & 0xff;
  out[3] = n >> 8;
  out.set(Array.from(payload), 4);
  const crc = crc16(out.subarray(2, 4 + n));
  out[4 + n] = crc >> 8;
  out[5 + n] = crc & 0xff;
  return out;
}

export interface Decoded {
  payload: Uint8Array;
  crcOk: boolean;
}

/** null unless `data` is exactly one complete frame. */
export function decode(data: Uint8Array): Decoded | null {
  if (data.length < 6 || data[0] !== SYNC[0] || data[1] !== SYNC[1]) return null;
  const n = data[2] | (data[3] << 8);
  if (data.length !== n + 6) return null;
  const expected = (data[data.length - 2] << 8) | data[data.length - 1];
  return { payload: data.slice(4, 4 + n), crcOk: crc16(data.subarray(2, data.length - 2)) === expected };
}

export function hex(data: ArrayLike<number>): string {
  return Array.from({ length: data.length }, (_, i) => data[i].toString(16).padStart(2, "0")).join(" ");
}

/** Collects raw bytes (BLE notifications or zero-padded HID reports) and
 *  yields whole frames, dropping bytes until an aa 55 header to resync. */
export class FrameReassembler {
  private buf: number[] = [];

  clear(): void {
    this.buf = [];
  }

  feed(data: Uint8Array): Uint8Array[] {
    for (const b of data) this.buf.push(b);
    const frames: Uint8Array[] = [];
    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === SYNC[0] && this.buf[i + 1] === SYNC[1]) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        // A trailing 0xaa may be the first half of a header.
        const last = this.buf[this.buf.length - 1];
        this.buf = last === SYNC[0] ? [last] : [];
        return frames;
      }
      this.buf.splice(0, start);
      if (this.buf.length < 4) return frames;
      const n = this.buf[2] | (this.buf[3] << 8);
      if (this.buf.length < n + 6) return frames;
      frames.push(Uint8Array.from(this.buf.splice(0, n + 6)));
    }
  }
}
