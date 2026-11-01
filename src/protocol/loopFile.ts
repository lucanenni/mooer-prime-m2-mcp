// Loop files on the pedal (USB only): file type 6, slots 1...10, transferred in frames of 1000 bytes.
// A stored file is 1000 bytes of control data followed by the audio, 24-bit stereo PCM at 44.1 kHz.

export const LOOP_FILE_TYPE = 6;
export const FILE_READ = 0x63;
export const FILE_READ_REPLY = 0x64;
export const FILE_WRITE = 0x61;
export const LOOP_CONTROL_BYTES = 1000;
export const LOOP_FRAME_BYTES = 1000;
/** Largest loop file the pedal accepts, in bytes. */
export const LOOP_MAX_BYTES = 136_314_800;
export const LOOP_SAMPLE_RATE = 44100;
const BYTES_PER_FRAME = 6; // 2 channels x 3 bytes

export interface FileFrame {
  /** 0 = the file does not exist. */
  status: number;
  /** Number of frames including the first one, which carries the file name. */
  total: number;
  index: number;
  data: Uint8Array;
}

/** Reply `64 type id(u16) status total(u32) index(u32) length(u16) data`; null for an error reply. */
export function parseFileFrame(p: Uint8Array): FileFrame | null {
  if (p.length < 15 || p[0] !== FILE_READ_REPLY) return null;
  const u32 = (o: number) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;
  const length = p[13] | (p[14] << 8);
  if (p.length < 15 + length) return null;
  return { status: p[4], total: u32(5), index: u32(9), data: p.slice(15, 15 + length) };
}

/** Request for frame `index` of loop file `id`. */
export const fileFrameRequest = (id: number, index: number, type = LOOP_FILE_TYPE) =>
  Uint8Array.of(FILE_READ, type, id & 0xff, id >> 8, index & 0xff, (index >> 8) & 0xff, (index >> 16) & 0xff, (index >>> 24) & 0xff);

/** Splits the stored file into control data and audio (a trailing block of 1000 zero bytes is padding). */
export function splitLoopFile(raw: Uint8Array): { control: Uint8Array; audio: Uint8Array } {
  const control = raw.slice(0, LOOP_CONTROL_BYTES);
  let audio = raw.slice(LOOP_CONTROL_BYTES);
  if (audio.length > LOOP_CONTROL_BYTES && audio.subarray(audio.length - LOOP_CONTROL_BYTES).every((b) => b === 0)) {
    audio = audio.slice(0, audio.length - LOOP_CONTROL_BYTES);
  }
  return { control, audio: audio.slice(0, audio.length - (audio.length % BYTES_PER_FRAME)) };
}

/** A WAV file with the audio chunk followed by the control data, after the chunk, so a re-import can restore it. */
export function buildWav(audio: Uint8Array, control: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + audio.length + control.length));
  const view = new DataView(out.buffer);
  const text = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + audio.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true);
  view.setUint32(24, LOOP_SAMPLE_RATE, true);
  view.setUint32(28, LOOP_SAMPLE_RATE * BYTES_PER_FRAME, true);
  view.setUint16(32, BYTES_PER_FRAME, true);
  view.setUint16(34, 24, true);
  text(36, "data");
  view.setUint32(40, audio.length, true);
  out.set(audio, 44);
  out.set(control, 44 + audio.length);
  return out;
}

/** Frame `index` of an upload: `61 type id(u16) total(u32) index(u32) length(u16) data`. Frame 0 carries the name. */
export function fileFrameWrite(id: number, total: number, index: number, data: Uint8Array, type = LOOP_FILE_TYPE): Uint8Array {
  const out = new Uint8Array(14 + data.length);
  const view = new DataView(out.buffer);
  out[0] = FILE_WRITE;
  out[1] = type;
  view.setUint16(2, id, true);
  view.setUint32(4, total, true);
  view.setUint32(8, index, true);
  view.setUint16(12, data.length, true);
  out.set(data, 14);
  return out;
}

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bits: number;
  dataOffset: number;
  dataSize: number;
}

/** Finds the format and the data chunk of a WAV file; null when it is not a usable WAV. */
export function readWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Pick<WavInfo, "audioFormat" | "channels" | "sampleRate" | "bits"> | undefined;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = String.fromCharCode(...bytes.subarray(o, o + 4));
    const size = view.getUint32(o + 4, true);
    if (id === "fmt " && o + 24 <= bytes.length) {
      fmt = { audioFormat: view.getUint16(o + 8, true), channels: view.getUint16(o + 10, true), sampleRate: view.getUint32(o + 12, true), bits: view.getUint16(o + 22, true) };
    } else if (id === "data") {
      if (!fmt) return null;
      return { ...fmt, dataOffset: o + 8, dataSize: Math.min(size, bytes.length - (o + 8)) };
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

/** True when the WAV already has the pedal's audio format (24-bit PCM, stereo, 44.1 kHz). */
export const isPedalFormat = (w: WavInfo) => w.audioFormat === 1 && w.channels === 2 && w.sampleRate === LOOP_SAMPLE_RATE && w.bits === 24;

/** The 1000 control bytes after the data chunk of a WAV exported from the pedal (zeros when absent). */
export function wavControl(bytes: Uint8Array, w: WavInfo): Uint8Array {
  const control = new Uint8Array(LOOP_CONTROL_BYTES);
  control.set(bytes.subarray(w.dataOffset + w.dataSize, w.dataOffset + w.dataSize + LOOP_CONTROL_BYTES));
  return control;
}

/** Interleaved 24-bit little-endian stereo PCM from float channels (a missing right channel repeats the left). */
export function packPcm24(left: Float32Array, right: Float32Array = left): Uint8Array {
  const length = Math.max(left.length, right.length);
  const out = new Uint8Array(length * BYTES_PER_FRAME);
  const to24 = (v: number) => Math.round(Math.max(-1, Math.min(1, v || 0)) * (v > 0 ? 8388607 : 8388608));
  for (let i = 0; i < length; i++) {
    const l = to24(left[i]);
    const r = to24(right[i]);
    out.set([l & 255, (l >> 8) & 255, (l >> 16) & 255, r & 255, (r >> 8) & 255, (r >> 16) & 255], i * BYTES_PER_FRAME);
  }
  return out;
}

// ---- Sample files: cabs, drives, pre-amps, entire amps ----------------------------------------------

/** File types of the sample slots (10 each), in the order of Prime Studio's tabs. */
export const SAMPLE_TYPES = [
  { type: 2, label: "Drive", extension: "gnr", accepts: ".gnr,.drive" },
  { type: 3, label: "Pre-Amp", extension: "preamp", accepts: ".preamp,.nam" },
  { type: 4, label: "Entire Amp", extension: "entire", accepts: ".entire,.nam" },
  { type: 1, label: "Cab (IR)", extension: "gir", accepts: ".gir,.wav" },
] as const;
/** The sample file type behind each effect type that can use user models (Drive, Pre-Amp, Cab, Entire Amp). */
export const SAMPLE_FILE_FOR_MODULE: Record<number, number> = { 0x01: 2, 0x02: 3, 0x03: 1, 0x0b: 4 };
export const SAMPLE_FRAME_BYTES = 400;
export const CAB_IR_SAMPLES = 1024;

/** What follows the `data` chunk header of a WAV-like container, or the whole file when there is none. */
export function dataSection(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] === 0x64 && bytes[i + 1] === 0x61 && bytes[i + 2] === 0x74 && bytes[i + 3] === 0x61) {
      const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
      if (size > 0 && size <= bytes.length - i - 8) return bytes.slice(i + 8, i + 8 + size);
      break;
    }
  }
  return bytes;
}

/** A cab impulse response as the pedal stores it: the first 1024 samples as little-endian float32. */
export function packCabIr(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(CAB_IR_SAMPLES * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < Math.min(samples.length, CAB_IR_SAMPLES); i++) view.setFloat32(i * 4, samples[i], true);
  return out;
}

/** Largest sample file the editor will send; real captures are far smaller, this only stops a wrong pick (a song, a video). */
export const SAMPLE_MAX_BYTES = 8_000_000;

/** A reason not to send this file to a sample slot of `type`, or null when it looks fine. */
export function checkSampleFile(type: number, fileName: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "The file is empty.";
  if (bytes.length > SAMPLE_MAX_BYTES) return `The file is ${(bytes.length / 1e6).toFixed(1)} MB; sample files are much smaller. Is it the right one?`;
  const riff = bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  if (riff && type !== 1) return "WAV files are for the Cab slots; drives, pre-amps and amps take their own formats or a NAM capture.";
  if (/\.nam$/i.test(fileName) && type !== 3 && type !== 4) return "NAM captures go to the Pre-Amp or Entire Amp slots.";
  return null;
}
