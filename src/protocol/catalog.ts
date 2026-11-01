// Labels, parameter layouts, value formatting and slider ranges.
// Models are shown as wire value + 1 (wire 1 -> "02 Flex Boost").

import { MODEL_NAMES } from "./modelNames";
import { type PrimeModule, isEmpty, modelOf } from "./models";

export { MODEL_NAMES };

export type ParamKind =
  | "knob" // 0...100
  | "ms" // high bit (0x8000) = tempo-synced, low bits = sync index
  | "hz"
  | "off" // raw Hz, 0 = OFF
  | "eqGain" // dB = (raw - 32) / 2
  | "eqQ" // (raw + 2) / 10
  | "rate" // 0...100; 101 + n = tempo-synced to note n
  | "pitch" // semitones = raw / 10 - 12
  | "simGain" // dB = (raw - 120) / 10
  | "midShift" // Hz = raw + 200
  | "unknown";

export interface Param {
  label: string;
  kind: ParamKind;
  range?: [number, number];
}

const p = (label: string, kind: ParamKind = "knob", range?: [number, number]): Param => ({ label, kind, range });

export const TYPE_NAMES: Record<number, string> = {
  0x01: "Drive",
  0x02: "Pre-Amp",
  0x03: "Cab",
  0x04: "Dyna",
  0x05: "Filter",
  0x06: "Mod",
  0x07: "Delay",
  0x08: "Reverb",
  0x09: "EQ",
  0x0a: "Guitar Sim",
  0x0b: "Entire Amp",
};

/** Categories in the order of the picker. */
export const CATEGORY_ORDER = [0x0a, 0x01, 0x02, 0x03, 0x0b, 0x04, 0x05, 0x09, 0x06, 0x07, 0x08];

/** Slots the editor offers (9). */
export const MAX_MODULES = 9;

const rateMod = (...rest: Param[]) => [p("Rate", "rate"), ...rest];
const delayFull = [p("Level"), p("Feedback"), p("Time", "ms", [40, 2500]), p("Depth"), p("Rate")];

/** Models whose parameters differ from their type's default list. */
const MODEL_PARAMS: Record<number, Record<number, Param[]>> = {
  0x04: { 0: [p("Sensitivity"), p("Level")], 2: [p("Threshold"), p("Level")] },
  // Touch Wah word order assumed from the app's display order.
  0x05: { 0: [p("Peak"), p("Sensitivity"), p("Level")], 2: [p("Rate"), p("Q"), p("Mix")] },
  0x06: {
    0: rateMod(p("Level"), p("Depth")),
    1: rateMod(p("Level"), p("Depth")),
    2: rateMod(p("Mix"), p("Feedback")),
    3: rateMod(p("Mix"), p("Feedback")),
    4: rateMod(p("Mix"), p("Tone")),
    5: rateMod(p("Mix"), p("Tone")),
    6: rateMod(p("Mix"), p("Tone")),
    7: rateMod(p("Mix"), p("Tone")),
    8: rateMod(p("Mix"), p("Tone")),
    9: [p("Mix"), p("Tone"), p("Pitch", "pitch")],
    12: [p("Sample"), p("Mix"), p("Bit")],
    13: [p("Rise"), p("Level")],
  },
  // Delay words 4-5 are only shown for Crystal and Rainbow.
  0x07: { 7: delayFull, 8: delayFull },
  // Words after Level are not shown.
  0x09: { 0: [...["100Hz", "250Hz", "630Hz", "1.6kHz", "4kHz"].map((l) => p(l, "eqGain")), p("Level")] },
};

function eqParams(): Param[] {
  const bands: [string, [number, number]][] = [
    ["Low", [40, 600]],
    ["Low Mid", [200, 2000]],
    ["High Mid", [600, 6000]],
    ["High", [1500, 20000]],
  ];
  const out: Param[] = [];
  for (const [band, freq] of bands) out.push(p(`${band} Gain`, "eqGain"), p(`${band} Freq`, "hz", freq), p(`${band} Q`, "eqQ"));
  out.push(p("Low Cut", "off", [0, 600]), p("High Cut", "off", [0, 2000]), p("Level"));
  return out;
}

const ampParams = [p("Gain"), p("Bass"), p("Mid"), p("Treble"), p("Presence"), p("Master")];

/** Parameters in word order (after enabled + model). */
const PARAMS: Record<number, Param[]> = {
  0x01: [p("Gain"), p("Tone"), p("Vol")],
  0x02: ampParams,
  0x03: [p("Gain"), p("Low Cut", "off", [0, 600]), p("High Cut", "off", [0, 2000])],
  0x04: [p("Attack"), p("Ratio"), p("Threshold"), p("Level")],
  0x05: [p("Rate"), p("Peak"), p("Range"), p("Level")],
  0x06: rateMod(p("Mix"), p("Tone"), p("Depth")),
  0x07: [p("Level"), p("Feedback"), p("Time", "ms", [40, 2500])],
  0x08: [p("Pre Delay", "ms", [0, 200]), p("Level"), p("Decay"), p("Tone")],
  0x09: eqParams(),
  0x0a: [p("Gain"), p("Blend"), p("Low", "simGain"), p("Mid", "simGain"), p("Mid Shift", "midShift"), p("High", "simGain")],
  0x0b: ampParams,
};

/** Tempo-sync notes in slider order with their stored index. */
export const SYNC_NOTE_ORDER: [number, string][] = [
  [2, "1/32"], [4, "1/32D"], [0, "1/32T"], [5, "1/16"], [7, "1/16D"], [1, "1/16T"],
  [8, "1/8"], [9, "1/8D"], [3, "1/8T"], [10, "1/4"], [12, "1/4D"], [6, "1/4T"],
  [13, "1/2"], [14, "1/2D"], [11, "1/2T"], [15, "1/1"],
];
const SYNC_NOTES = new Map(SYNC_NOTE_ORDER);

/** A reasonable starting value for a parameter of a module created offline. */
function defaultWord(x: Param): number {
  switch (x.kind) {
    case "knob":
    case "rate":
      return 50;
    case "ms":
      return x.label === "Time" ? 500 : 0;
    case "hz":
      return x.range?.[0] ?? 0;
    case "eqGain":
      return 32;
    case "eqQ":
      return 10;
    case "pitch":
    case "simGain":
      return 120;
    default:
      return 0;
  }
}

/** The 17 words of a new module: on, model, then the visible parameters at their defaults. */
export function defaultWords(type: number, model: number): number[] {
  const words = [1, model];
  for (let i = 0; param(type, model, i).kind !== "unknown"; i++) words.push(defaultWord(param(type, model, i)));
  while (words.length < 17) words.push(0);
  return words;
}

export const typeName = (type: number) => TYPE_NAMES[type] ?? `Type 0x${type.toString(16).padStart(2, "0")}`;

export const modelsOf = (type: number): number[] =>
  Object.keys(MODEL_NAMES[type] ?? {}).map(Number).sort((a, b) => a - b);

/** "02 Flex Boost", or just "07" when the name isn't known. */
export function modelLabel(type: number, model: number): string {
  const num = String(model + 1).padStart(2, "0");
  const name = MODEL_NAMES[type]?.[model];
  return name ? `${num} ${name}` : num;
}

export function isUnnamed(m: PrimeModule): boolean {
  if (isEmpty(m)) return false;
  const model = modelOf(m);
  return !(m.type in TYPE_NAMES) || model === undefined || !(model in (MODEL_NAMES[m.type] ?? {}));
}

/** `index` counts from 0 at the first word after enabled + model. */
export function param(type: number, model: number | undefined, index: number): Param {
  const list = (model !== undefined ? MODEL_PARAMS[type]?.[model] : undefined) ?? PARAMS[type];
  return list?.[index] ?? p(`P${index + 1}`, "unknown");
}

export const syncLabel = (index: number) => `♩ ${SYNC_NOTES.get(index) ?? `sync #${index}`}`;

export function syncIndex(param: Param, value: number): number | null {
  if (param.kind === "ms") return value & 0x8000 ? value & 0x7fff : null;
  if (param.kind === "rate") return value > 100 ? value - 101 : null;
  return null;
}

/** Length of a sync note in ms at `bpm` (1/4 = one beat, D = dotted, T = triplet). */
export function syncMs(index: number, bpm: number): number {
  const note = SYNC_NOTES.get(index) ?? "1/4";
  const beats = (4 / Number(note.slice(2).replace(/\D+$/, ""))) * (note.endsWith("D") ? 1.5 : note.endsWith("T") ? 2 / 3 : 1);
  return (60000 / bpm) * beats;
}

/** The sync note whose length at `bpm` is closest to `ms`. */
export function nearestSync(ms: number, bpm: number): number {
  return SYNC_NOTE_ORDER.reduce((best, [i]) => (Math.abs(syncMs(i, bpm) - ms) < Math.abs(syncMs(best, bpm) - ms) ? i : best), SYNC_NOTE_ORDER[0][0]);
}

export const syncedValue = (kind: ParamKind, index: number) => (kind === "rate" ? 101 + index : 0x8000 | index);

/** Has a tempo-sync button (Delay Time, Mod Rate). */
export const isSyncable = (x: Param) => x.kind === "rate" || (x.kind === "ms" && x.label === "Time");

export function formatValue(value: number, kind: ParamKind): string {
  switch (kind) {
    case "ms":
      return value & 0x8000 ? syncLabel(value & 0x7fff) : `${value} ms`;
    case "hz":
      return `${value} Hz`;
    case "off":
      return value === 0 ? "OFF" : `${value} Hz`;
    case "eqGain":
      return `${((value - 32) / 2).toFixed(1).replace(/^(\d)/, "+$1")} dB`;
    case "eqQ":
      return ((value + 2) / 10).toFixed(1);
    case "rate":
      return value > 100 ? syncLabel(value - 101) : String(value);
    case "pitch":
      return (value / 10 - 12).toFixed(1);
    case "simGain":
      return `${((value - 120) / 10).toFixed(1).replace(/^(\d)/, "+$1")} dB`;
    case "midShift":
      return `${value + 200} Hz`;
    default:
      return String(value);
  }
}

/** Raw slider range, or null when the word gets a number field (also when the
 *  stored value lies outside the known range, e.g. tempo-synced delay times). */
export function sliderRange(x: Param, value: number): [number, number] | null {
  let range: [number, number] | undefined;
  switch (x.kind) {
    case "knob":
    case "rate":
    case "unknown":
      range = x.range ?? [0, 100];
      break;
    case "simGain":
      range = [0, 240];
      break;
    case "midShift":
      range = [0, 1800];
      break;
    case "eqGain":
      range = [0, 64];
      break;
    case "eqQ":
      range = [0, 98];
      break;
    case "pitch":
      range = [0, 240];
      break;
    default:
      range = x.range;
  }
  if (!range || value < range[0] || value > range[1]) return null;
  return range;
}
