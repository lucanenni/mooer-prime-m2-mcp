// A simulated pedal for trying the interface without hardware (open the page with `?demo`).
// It answers the commands the editor uses over a fake Bluetooth link; it is not a faithful emulation.

import * as frame from "../protocol/frame";
import type { PrimeM2Device, Transport } from "../protocol/device";
import * as catalog from "../protocol/catalog";
import { CloudPreset } from "../protocol/cloudPreset";
import { type PrimeModule, encodeModule, encodeName } from "../protocol/models";

const DEFAULTS: { type: number; model: number; params: number[] }[] = [
  { type: 0x01, model: 3, params: [50, 50, 50] }, // Drive 808
  { type: 0x02, model: 4, params: [50, 50, 50, 50, 50, 50] }, // Pre-Amp
  { type: 0x03, model: 7, params: [50, 0, 0] }, // Cab
  { type: 0x07, model: 1, params: [40, 30, 500] }, // Delay
  { type: 0x08, model: 1, params: [0, 40, 50, 50] }, // Reverb
];

const newModule = (slot: number, d = DEFAULTS[(slot - 1) % DEFAULTS.length]): PrimeModule => ({ slot, type: d.type, words: [1, d.model, ...d.params] });

function initialState(): Uint8Array {
  const s = new Uint8Array(99);
  s[0] = 0x12;
  s[1] = 1;
  s[2] = 1;
  s.set([24, 24, 24, 24, 9, 255], 3);
  s.set(encodeName("M2Prime M2"), 9);
  s.set([0, 60, 0, 60, 0, 60, 0, 0, 60, 60, 0, 60, 120, 0, 1, 10, 1, 0, 60, 1, 0], 29);
  s.set([255, 1, 60, 1, 0, 70, 0, 20, 0, 1, 0, 24, 0, 24, 0, 24, 0, 1, 0, 40, 0, 50, 0, 50, 0, 25, 0], 50);
  s.set([50, 50, 50, 50, 1, 1, 1, 1, 3, 0], 89);
  return s;
}

/** `offline`: an empty workspace of 80 blank presets that behaves like a pedal connected over USB, so presets can
 *  be built, edited and exported to files without hardware. */
const STORE_KEY = "mooer-m2-offline-workspace";

type StoredPreset = { name: string; modules: PrimeModule[]; bpm: number; raw?: Uint8Array };

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

/** Restores the offline workspace saved in this browser, or null when there is none (or storage is unavailable). */
function loadWorkspace(): { presets: StoredPreset[]; current: number } | null {
  try {
    const data = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (!data || !Array.isArray(data.presets) || data.presets.length !== 81) return null;
    const presets: StoredPreset[] = data.presets.map((x: { name: string; modules: PrimeModule[]; bpm: number; raw?: string }) => ({ name: x.name, modules: x.modules, bpm: x.bpm, raw: x.raw ? fromBase64(x.raw) : undefined }));
    return { presets, current: Number(data.current) || 1 };
  } catch {
    return null;
  }
}

function saveWorkspace(presets: StoredPreset[], current: number) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ current, presets: presets.map((x) => ({ ...x, raw: x.raw ? toBase64(x.raw) : undefined })) }));
  } catch {
    // storage full or blocked: the workspace simply is not remembered
  }
}

/** Forgets the saved offline workspace. */
export function clearWorkspace() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

export function attachDemoPedal(device: PrimeM2Device, offline = false): void {
  const state = initialState();
  const restored = offline ? loadWorkspace() : null;
  const stored: StoredPreset[] =
    restored?.presets ??
    Array.from({ length: 81 }, (_, i) => ({
      name: i === 0 ? "" : offline ? "Empty" : `Demo ${i}`,
      modules: offline ? [] : DEFAULTS.map((_, k) => newModule(k + 1)),
      bpm: 120,
    }));
  if (restored) state[1] = restored.current;
  let buffer = structuredClone(stored[state[1]]);

  const presetPayload = (idx: number) => {
    const source = idx === state[1] ? buffer : stored[idx];
    const slots = Array.from({ length: 20 }, (_, k) => source.modules[k]);
    return [0x22, idx, ...encodeName(source.name), ...slots.flatMap((m, k) => (m ? Array.from(encodeModule({ ...m, slot: k + 1 })) : [k + 1, 0, 0])), 0, 0, 0, 0, 0, 0, 0];
  };

  type Stored = (typeof stored)[number];
  const toCloud = (x: Stored) =>
    (x.raw && CloudPreset.fromFile(x.raw)) ||
    CloudPreset.fromPreset(x.name, x.bpm, x.modules.map((m) => ({ type: m.type, words: [...m.words, ...new Array(Math.max(0, 17 - m.words.length)).fill(0)] })));
  const fromCloud = (c: CloudPreset): Stored => ({ name: c.name, bpm: c.bpm, raw: c.fileData, modules: c.modules.map((m, k) => ({ slot: k + 1, type: m.type, words: m.words })) });
  const incoming = new Map<number, Uint8Array[]>();
  /** Names of the sample files per file type (1 Cab, 2 Drive, 3 Pre-Amp, 4 Entire Amp), ten slots each; empty = free. */
  const samples: Record<number, string[]> = { 1: Array(10).fill(""), 2: Array(10).fill(""), 3: Array(10).fill(""), 4: Array(10).fill("") };

  const respond = (p: number[]): number[] | null => {
    switch (p[0]) {
      case 0xab: {
        if (!offline) return null;
        const cloud = toCloud(p[1] === 0 || p[1] === state[1] ? buffer : stored[p[1]]);
        const n = p[2] | (p[3] << 8);
        if (n === 0) return [0xac, cloud.frames.length, 0];
        const data = cloud.frames[n - 1];
        return [0xac, n & 0xff, n >> 8, data.length & 0xff, data.length >> 8, ...data];
      }
      case 0xad: {
        if (!offline) return null;
        const [, idx, nlo, nhi, llo, lhi, ...data] = p;
        const n = nlo | (nhi << 8);
        if (idx === 0xff) {
          buffer = structuredClone(stored[state[1]]);
          return [0xae, nlo, nhi, 1];
        }
        const frames = incoming.get(idx) ?? [];
        frames[n - 1] = Uint8Array.from(data.slice(0, llo | (lhi << 8)));
        incoming.set(idx, frames);
        if (frames.length === 3 && frames.every(Boolean)) {
          incoming.delete(idx);
          const cloud = CloudPreset.fromFrames(frames);
          if (!cloud) return [0xae, nlo, nhi, 0];
          if (idx === 0) buffer = fromCloud(cloud);
          else stored[idx] = fromCloud(cloud);
          if (idx === state[1]) buffer = structuredClone(stored[idx]);
        }
        return [0xae, nlo, nhi, 1];
      }
      case 0x01: return [0x02, 0x41, 0x01, ...Array.from("V1.5.0", (c) => c.charCodeAt(0)), 0];
      case 0xa9: return [0xaa, 0, 0, ...Array.from("demo", (c) => c.charCodeAt(0)), 0];
      case 0x29: return [0x2a, p[1], p[2], ...Array.from({ length: p[2] - p[1] + 1 }, (_, i) => Array.from(encodeName(stored[p[1] + i].name))).flat()];
      case 0x11: return Array.from(state);
      case 0x13: {
        state.set(p.slice(1), 1);
        buffer = structuredClone(stored[state[1]]);
        return [0x14, 1];
      }
      case 0x21: return presetPayload(p[1]);
      case 0x23: return [0x24, ...encodeModule({ ...(buffer.modules[p[1] - 1] ?? { type: 0, words: [] }), slot: p[1] })];
      case 0x25: {
        const slot = p[1];
        const words = Array.from({ length: p[3] / 2 }, (_, i) => p[4 + i * 2] | (p[5 + i * 2] << 8));
        if (buffer.modules[slot - 1]) buffer.modules[slot - 1] = { slot, type: p[2], words };
        buffer.raw = undefined;
        return [0x26, 1];
      }
      case 0x2d: {
        const [, id, op, a, b, c] = p;
        const m = buffer.modules;
        buffer.raw = undefined;
        let ok = true;
        if (op === 1 || op === 2) {
          if (a > m.length + 1) ok = false;
          else m[a - 1] = { slot: a, type: b, words: offline ? catalog.defaultWords(b, c) : [1, c, ...(DEFAULTS.find((d) => d.type === b)?.params ?? [50, 50, 50])] };
        } else if (op === 3) {
          m.splice(a - 1, 1);
        } else if (op === 4 && a >= 1 && a <= m.length && b >= 1 && b <= m.length) {
          m.splice(b - 1, 0, ...m.splice(a - 1, 1));
        } else ok = false;
        return [0x2e, id, ok ? 1 : 0];
      }
      case 0x2f: {
        const name = new TextDecoder().decode(Uint8Array.from(p.slice(2, 22))).replace(/\0.*$/, "");
        stored[p[1]] = { ...structuredClone(buffer), name, raw: undefined };
        buffer = structuredClone(stored[p[1]]);
        return [0x30, 1];
      }
      case 0x33: return [0x34, stored[p[1]].bpm & 0xff, stored[p[1]].bpm >> 8];
      case 0x4d: return [0x4e, 1];
      case 0x53: return [0x54, ...Array.from({ length: 10 }, () => [1, 0, 0, 0, 0, 0, ...encodeName("")]).flat()];
      case 0xb1: return [0xb2, ...[[1, 26], [1, 25], [1, 10], [1, 22], [1, 11], [1, 24], [0, 255], [0, 255], [1, 14], ...Array.from({ length: 11 }, () => [0, 255])].flat()];
      case 0xb3: return [0xb4, 1, 0, 0];
      case 0xb5: case 0xb7: return [p[0] + 1, 1];
      case 0x65: {
        const first = p[2] | (p[3] << 8);
        const count = (p[4] | (p[5] << 8)) - first + 1;
        const record = (n: number) => {
          const sample = p[1] >= 1 && p[1] <= 4 ? samples[p[1]]?.[n - 1] ?? "" : `PATTERN ${n}`;
          return [p[1], n & 0xff, n >> 8, sample ? 0 : 1, 1, ...encodeName(sample, 50), 0, 0, 0, 0];
        };
        return [0x66, ...Array.from({ length: count }, (_, i) => record(first + i)).flat()];
      }
      case 0x61: {
        // `61 type id(2) total(4) index(4) len(2) data`: frame 0 carries the name, the others the data
        const type = p[1];
        const id = p[2] | (p[3] << 8);
        const index = p[8] | (p[9] << 8);
        if (index === 0 && samples[type]) samples[type][id - 1] = new TextDecoder().decode(Uint8Array.from(p.slice(14, 14 + (p[12] | (p[13] << 8)))));
        return [0x62, 1];
      }
      case 0x67: {
        // `67 type id(2) 01 name` -> `68 type id ok`
        if (samples[p[1]]) samples[p[1]][(p[2] | (p[3] << 8)) - 1] = "";
        return [0x68, p[1], p[2], p[3], 1];
      }
      case 0x91: return [0x92, 80, 0];
      default: return null;
    }
  };

  const kind = offline ? "USB" : "Bluetooth";
  const transport: Transport = {
    kind,
    async close() {},
    async write(data) {
      const decoded = frame.decode(data);
      if (!decoded) return;
      const reply = respond(Array.from(decoded.payload));
      if (offline && [0x13, 0x25, 0x2d, 0x2f, 0xad].includes(decoded.payload[0])) saveWorkspace(stored, state[1]);
      if (reply) setTimeout(() => device.receive(kind, frame.encode(reply)), 5);
    },
  };
  device.attach(transport);
}
