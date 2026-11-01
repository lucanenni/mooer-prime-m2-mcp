import type { WavInfo } from "./protocol/loopFile";
import { PedalError } from "./session";

/** Sample access for 8/16/24/32-bit PCM and 32-bit float WAVs; a mono file repeats its channel. */
export function wavSamples(bytes: Uint8Array, wav: WavInfo) {
  const isFloat = wav.audioFormat === 3 && wav.bits === 32;
  if (!(wav.audioFormat === 1 && [8, 16, 24, 32].includes(wav.bits)) && !isFloat) throw new PedalError("Unsupported WAV format (need PCM 8/16/24/32-bit or 32-bit float).");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = wav.bits / 8;
  const frames = Math.floor(wav.dataSize / (step * wav.channels));
  const sample = (frame: number, ch: number) => {
    const o = wav.dataOffset + (frame * wav.channels + Math.min(ch, wav.channels - 1)) * step;
    if (isFloat) return view.getFloat32(o, true);
    if (wav.bits === 8) return (view.getUint8(o) - 128) / 128;
    if (wav.bits === 16) return view.getInt16(o, true) / 32768;
    if (wav.bits === 24) return ((view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)) | 0) / 8388608;
    return view.getInt32(o, true) / 2147483648;
  };
  return { frames, sample };
}
