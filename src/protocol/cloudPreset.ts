// A stored preset in Mooer Studio's "cloud" format (USB only): 1198 bytes in 3 frames
// (322 + 512 + 364 on the M2). See upstream docs/PROTOCOL.md §7.

import { crc16 } from "./frame";
import { decodeName, encodeName } from "./models";

export const BACKUP_READ = 0xab;
export const BACKUP_READ_REPLY = 0xac;
export const RECOVERY_WRITE = 0xad;
export const RECOVERY_WRITE_REPLY = 0xae;

const BPM_OFFSET = 390;
const NAME_OFFSET = 392;
const NAME_LENGTH = 20;
const MODULES_OFFSET = 412;
const MODULE_SIZE = 36; // type u16 + 17 x u16 words
const MODULE_COUNT = 20;
const CRC_START = 322;
const CRC_OFFSET = 1196; // CRC-16/GSM over 322..<1196, little-endian
export const CLOUD_SIZE = 1198;

export class CloudPreset {
  private constructor(readonly frameLengths: number[], readonly data: Uint8Array) {}

  static fromFrames(frames: Uint8Array[]): CloudPreset | null {
    const data = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      data.set(f, offset);
      offset += f.length;
    }
    return data.length === CLOUD_SIZE ? new CloudPreset(frames.map((f) => f.length), data) : null;
  }

  /** Mooer Studio's `.preset` file: u16 frameCount, u16 lengths..., frame data. */
  static fromFile(file: Uint8Array): CloudPreset | null {
    if (file.length < 2) return null;
    const count = file[0] | (file[1] << 8);
    if (file.length < 2 + 2 * count) return null;
    const lengths = Array.from({ length: count }, (_, k) => file[2 + 2 * k] | (file[3 + 2 * k] << 8));
    let offset = 2 + 2 * count;
    const frames: Uint8Array[] = [];
    for (const n of lengths) {
      if (offset + n > file.length) return null;
      frames.push(file.slice(offset, offset + n));
      offset += n;
    }
    return CloudPreset.fromFrames(frames);
  }

  /** Builds a whole preset offline from a name, a tempo and effect modules (words = on/off, model, parameters;
   *  at most 20 modules of 17 words). Frames are 322 + 512 + 364 bytes. */
  static fromPreset(name: string, bpm: number, modules: { type: number; words: number[] }[]): CloudPreset {
    const data = new Uint8Array(CLOUD_SIZE);
    data.set([0xff, 0xff, 0x44, 0xaa, 0x20, 0x01], 320); // record marker
    data.set(encodeName(name), NAME_OFFSET);
    data[BPM_OFFSET] = bpm & 0xff;
    data[BPM_OFFSET + 1] = bpm >> 8;
    modules.slice(0, MODULE_COUNT).forEach((m, k) => {
      const at = MODULES_OFFSET + k * MODULE_SIZE;
      data[at] = m.type;
      m.words.slice(0, MODULE_SIZE / 2 - 1).forEach((w, i) => {
        data[at + 2 + i * 2] = w & 0xff;
        data[at + 3 + i * 2] = w >> 8;
      });
    });
    data.fill(0xff, MODULES_OFFSET + MODULE_COUNT * MODULE_SIZE + 2, CRC_OFFSET); // after the preset id
    data.copyWithin(326, 394, 458); // the device keeps a copy of the name block 0x44 bytes earlier
    const crc = crc16(data.subarray(CRC_START, CRC_OFFSET));
    data[CRC_OFFSET] = crc & 0xff;
    data[CRC_OFFSET + 1] = crc >> 8;
    return new CloudPreset([322, 512, 364], data);
  }

  /** A new preset with no effects at all. */
  static blank(name = "New preset", bpm = 120): CloudPreset {
    return CloudPreset.fromPreset(name, bpm, []);
  }

  /** The modules in chain order, as type + words (17 words each). */
  get modules(): { type: number; words: number[] }[] {
    const out: { type: number; words: number[] }[] = [];
    for (let k = 0; k < MODULE_COUNT; k++) {
      const at = MODULES_OFFSET + k * MODULE_SIZE;
      const type = this.word(at);
      if (!type) break;
      out.push({ type: type & 0xff, words: Array.from({ length: MODULE_SIZE / 2 - 1 }, (_, i) => this.word(at + 2 + i * 2)) });
    }
    return out;
  }

  get fileData(): Uint8Array {
    const n = this.frameLengths.length;
    const out = new Uint8Array(2 + 2 * n + this.data.length);
    out[0] = n & 0xff;
    out[1] = n >> 8;
    this.frameLengths.forEach((len, k) => {
      out[2 + 2 * k] = len & 0xff;
      out[3 + 2 * k] = len >> 8;
    });
    out.set(this.data, 2 + 2 * n);
    return out;
  }

  get frames(): Uint8Array[] {
    const out: Uint8Array[] = [];
    let offset = 0;
    for (const len of this.frameLengths) {
      out.push(this.data.subarray(offset, offset + len));
      offset += len;
    }
    return out;
  }

  get name(): string {
    return decodeName(this.data.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH));
  }

  get bpm(): number {
    return this.word(BPM_OFFSET);
  }

  get crcIsValid(): boolean {
    return this.word(CRC_OFFSET) === crc16(this.data.subarray(CRC_START, CRC_OFFSET));
  }

  /** Module types (low byte of each record's type word) in chain order, with on/off. */
  get chain(): { type: number; enabled: boolean }[] {
    const out: { type: number; enabled: boolean }[] = [];
    for (let k = 0; k < MODULE_COUNT; k++) {
      const offset = MODULES_OFFSET + k * MODULE_SIZE;
      const type = this.word(offset);
      if (type) out.push({ type: type & 0xff, enabled: this.word(offset + 2) !== 0 });
    }
    return out;
  }

  equals(other: CloudPreset): boolean {
    return this.data.length === other.data.length && this.data.every((b, i) => b === other.data[i]);
  }

  private word(offset: number): number {
    return this.data[offset] | (this.data[offset + 1] << 8);
  }
}

// ---- Bank file (all presets in one JSON file) ------------------------------

export interface BankEntry {
  index: number;
  name: string;
  preset: CloudPreset;
}

const BANK_FORMAT = "mooer-prime-m2-bank";

const toBase64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function encodeBank(entries: BankEntry[]): string {
  return JSON.stringify({
    format: BANK_FORMAT,
    version: 1,
    presets: entries.map((e) => ({ index: e.index, name: e.name, data: toBase64(e.preset.fileData) })),
  });
}

export function decodeBank(text: string): BankEntry[] | null {
  try {
    const json = JSON.parse(text);
    if (json?.format !== BANK_FORMAT || !Array.isArray(json.presets)) return null;
    const out: BankEntry[] = [];
    for (const p of json.presets) {
      const preset = CloudPreset.fromFile(fromBase64(String(p.data)));
      if (!preset) return null;
      out.push({ index: Number(p.index), name: String(p.name), preset });
    }
    return out;
  } catch {
    return null;
  }
}
