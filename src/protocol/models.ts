// Preset and module structs, wire-exact (see upstream docs/PROTOCOL.md).

export const NAME_LENGTH = 20;
export const SLOT_COUNT = 20;

/** One effect slot: slot# | type | n | data[n], data = n/2 x u16 LE.
 *  words[0] = enabled, words[1] = model, the rest are parameters. */
export interface PrimeModule {
  slot: number;
  type: number;
  words: number[];
}

export const isEmpty = (m: PrimeModule) => m.type === 0 && m.words.length === 0;
export const isEnabled = (m: PrimeModule) => m.words.length > 0 && m.words[0] !== 0;
export const modelOf = (m: PrimeModule): number | undefined => (m.words.length > 1 ? m.words[1] : undefined);

export function withWord(m: PrimeModule, index: number, value: number): PrimeModule {
  const words = m.words.slice();
  words[index] = value;
  return { ...m, words };
}

export function encodeModule(m: PrimeModule): Uint8Array {
  const out = new Uint8Array(3 + m.words.length * 2);
  out[0] = m.slot;
  out[1] = m.type;
  out[2] = m.words.length * 2;
  m.words.forEach((w, i) => {
    out[3 + i * 2] = w & 0xff;
    out[4 + i * 2] = (w >> 8) & 0xff;
  });
  return out;
}

export function parseModule(data: Uint8Array, offset: number): [PrimeModule, number] | null {
  if (offset + 3 > data.length) return null;
  const slot = data[offset];
  const type = data[offset + 1];
  const length = data[offset + 2];
  const end = offset + 3 + length;
  if (end > data.length) return null;
  const words: number[] = [];
  for (let i = offset + 3; i < end - 1; i += 2) words.push(data[i] | (data[i + 1] << 8));
  return [{ slot, type, words }, end];
}

export interface PrimePreset {
  index: number;
  name: string;
  modules: PrimeModule[];
  trailer: Uint8Array;
}

/** `payload` is the whole 0x22 frame payload, opcode included. */
export function parsePreset(payload: Uint8Array): PrimePreset | null {
  if (payload.length < 2 + NAME_LENGTH || payload[0] !== 0x22) return null;
  let offset = 2 + NAME_LENGTH;
  const modules: PrimeModule[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const parsed = parseModule(payload, offset);
    if (!parsed) return null;
    modules.push(parsed[0]);
    offset = parsed[1];
  }
  return { index: payload[1], name: decodeName(payload.subarray(2, 2 + NAME_LENGTH)), modules, trailer: payload.slice(offset) };
}

export function decodeName(data: Uint8Array): string {
  const end = data.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? data.subarray(0, end) : data);
}

/** NUL-padded/truncated to `length` bytes, printable ASCII only. */
export function encodeName(name: string, length = NAME_LENGTH): Uint8Array {
  const out = new Uint8Array(length);
  let n = 0;
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (code >= 0x20 && code < 0x80 && n < length) out[n++] = code;
  }
  return out;
}

/** 1...80 -> "0A"..."19D" (4 slots per bank, banks from 0). */
export function slotLabel(index: number): string {
  if (index < 1) return "?";
  const z = index - 1;
  return `${Math.floor(z / 4)}${"ABCD"[z % 4]}`;
}

/** Reply `66 07 ...` of the named-list command `65`: records of 59 bytes = category, index (u16),
 *  two flag bytes, then the NUL-padded name (the rest of the record is not decoded). */
const NAME_RECORD = 59;
export function parseNameList(payload: Uint8Array): { category: number; start: number; names: string[] } | null {
  if (payload.length < 1 + NAME_RECORD || payload[0] !== 0x66 || (payload.length - 1) % NAME_RECORD !== 0) return null;
  const body = payload.subarray(1);
  const count = body.length / NAME_RECORD;
  const start = body[1] | (body[2] << 8);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const rec = body.subarray(i * NAME_RECORD, (i + 1) * NAME_RECORD);
    if ((rec[1] | (rec[2] << 8)) !== start + i) return null;
    names.push(decodeName(rec.subarray(5, 5 + NAME_LENGTH)));
  }
  return { category: body[0], start, names };
}

/** A sample slot (cab, drive, pre-amp, entire amp) from the reply `66` of the list command `65`: records of 59 bytes =
 *  type, id (u16), empty flag, source, name (50 bytes), length (u32). */
export interface SampleSlot {
  id: number;
  empty: boolean;
  source: number;
  name: string;
  length: number;
}

export function parseSampleList(payload: Uint8Array): SampleSlot[] | null {
  if (payload.length < 1 + NAME_RECORD || payload[0] !== 0x66 || (payload.length - 1) % NAME_RECORD !== 0) return null;
  const out: SampleSlot[] = [];
  for (let at = 1; at < payload.length; at += NAME_RECORD) {
    const rec = payload.subarray(at, at + NAME_RECORD);
    const name = decodeName(rec.subarray(5, 55)).trim();
    out.push({
      id: rec[1] | (rec[2] << 8),
      empty: name === "", // the flag in rec[3] is not trusted: Studio also goes by the name
      source: rec[4],
      name,
      length: (rec[55] | (rec[56] << 8) | (rec[57] << 16) | (rec[58] << 24)) >>> 0,
    });
  }
  return out;
}

export interface LooperFile {
  empty: boolean;
  sync: boolean;
  ms: number;
  name: string;
}

const LOOPER_RECORD = 26;

/** Reply `54 ...` of `53 begin end`: records of 26 bytes = recorded flag (1 = has a loop), sync flag, time in ms (u32), name[20].
 *  The header size is derived from the payload length. */
export function parseLooperFiles(payload: Uint8Array): LooperFile[] | null {
  if (payload.length < 1 || payload[0] !== 0x54) return null;
  const body = payload.subarray(1);
  const skip = [0, 1, 2, 3].find((k) => body.length > k && (body.length - k) % LOOPER_RECORD === 0);
  if (skip === undefined) return null;
  const out: LooperFile[] = [];
  for (let off = skip; off + LOOPER_RECORD <= body.length; off += LOOPER_RECORD) {
    out.push({
      empty: body[off] === 0,
      sync: body[off + 1] !== 0,
      ms: (body[off + 2] | (body[off + 3] << 8) | (body[off + 4] << 16) | (body[off + 5] << 24)) >>> 0,
      name: decodeName(body.subarray(off + 6, off + LOOPER_RECORD)),
    });
  }
  return out;
}

/** The pedal's MIDI-controllable functions, in the order of the table of command `b1`. */
export const MIDI_FUNCTIONS = [
  "Page Up", "Page Down", "Preset A", "Preset B", "Preset C", "Preset D", "Delay Tap", "Tuner",
  "Drum Play / Stop", "Drum Up", "Drum Down", "Drum BPM Tap", "Drum Volume",
  "Looper Rec / Play", "Looper Undo / Redo", "Looper Stop", "Looper Delete", "Looper Volume", "Looper Song Up", "Looper Song Down",
] as const;

export interface MidiAssignment {
  assigned: boolean;
  /** Learned MIDI value (the controller number the app shows as "CC n"); 255 when unassigned. */
  value: number;
}

/** Reply `b2` of `b1`: one `flag, value` pair per function (flag 1 = assigned, value 255 = none). */
export function parseMidiTable(payload: Uint8Array): MidiAssignment[] | null {
  if (payload.length !== 1 + MIDI_FUNCTIONS.length * 2 || payload[0] !== 0xb2) return null;
  return MIDI_FUNCTIONS.map((_, i) => ({ assigned: payload[1 + i * 2] === 1, value: payload[2 + i * 2] }));
}
