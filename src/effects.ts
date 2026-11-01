// Effect modules in human terms: names, units, tempo-sync notes.

import * as catalog from "./protocol/catalog";
import { type PrimeModule, isEmpty, isEnabled, modelOf } from "./protocol/models";
import { SAMPLE_FILE_FOR_MODULE } from "./protocol/loopFile";
import { USER_MODEL_BASE } from "./protocol/modelNames";
import { stripNamMarker } from "./protocol/nam";
import { PedalError, session } from "./session";

const typeKeys = Object.keys(catalog.TYPE_NAMES).map(Number);

export function resolveType(t: string | number): number {
  if (typeof t === "number") {
    if (catalog.TYPE_NAMES[t]) return t;
    throw new PedalError(`Unknown effect type ${t}. Types: ${typeKeys.map((k) => `${k}=${catalog.TYPE_NAMES[k]}`).join(", ")}`);
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = typeKeys.find((k) => norm(catalog.TYPE_NAMES[k]) === norm(t));
  if (hit === undefined) throw new PedalError(`Unknown effect type "${t}". Types: ${typeKeys.map((k) => catalog.TYPE_NAMES[k]).join(", ")}`);
  return hit;
}

/** `model` is a wire id (number) or a name / "NN Name" label (string, unique substring match). */
export function resolveModel(type: number, model: string | number): number {
  const ids = catalog.modelsOf(type);
  if (typeof model === "number") {
    if (ids.includes(model)) return model;
    throw new PedalError(`${catalog.typeName(type)} has no model id ${model}. Valid ids: ${ids[0]}…${ids[ids.length - 1]}`);
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]/g, "");
  const want = norm(model);
  const labelled = ids.map((id) => ({ id, name: norm(catalog.MODEL_NAMES[type]?.[id] ?? ""), label: norm(catalog.modelLabel(type, id)) }));
  const exact = labelled.filter((m) => m.name === want || m.label === want);
  const found = exact.length ? exact : labelled.filter((m) => m.name.includes(want) || m.label.includes(want));
  if (found.length === 1) return found[0].id;
  if (!found.length) throw new PedalError(`No ${catalog.typeName(type)} model matches "${model}". Use list_effect_catalog with type "${catalog.typeName(type)}".`);
  throw new PedalError(`"${model}" is ambiguous for ${catalog.typeName(type)}: ${found.map((m) => catalog.modelLabel(type, m.id)).join(", ")}`);
}

const noteIndex = (note: string): number | undefined => {
  const n = note.trim().toUpperCase().replace(/^♩\s*/, "");
  return catalog.SYNC_NOTE_ORDER.find(([, label]) => label === n)?.[0];
};

export const SYNC_NOTES = catalog.SYNC_NOTE_ORDER.map(([, n]) => n);

/** Friendly value (number in the parameter's unit, or a sync note like "1/8D") -> raw word. */
export function encodeParam(prm: catalog.Param, value: number | string): number {
  if (typeof value === "string") {
    if (/^\s*off\s*$/i.test(value) && prm.kind === "off") return 0;
    const idx = noteIndex(value);
    if (idx === undefined || !catalog.isSyncable(prm)) {
      throw new PedalError(`"${value}" is not valid for ${prm.label}${catalog.isSyncable(prm) ? `; sync notes: ${SYNC_NOTES.join(", ")}` : ""}`);
    }
    return catalog.syncedValue(prm.kind, idx);
  }
  const v = Number(value);
  switch (prm.kind) {
    case "eqGain": return clampWord(Math.round(v * 2 + 32), 0, 64);
    case "eqQ": return clampWord(Math.round(v * 10 - 2), 0, 98);
    case "pitch": return clampWord(Math.round((v + 12) * 10), 0, 240);
    case "simGain": return clampWord(Math.round(v * 10 + 120), 0, 240);
    case "midShift": return clampWord(Math.round(v - 200), 0, 1800);
    case "ms": return clampWord(Math.round(v), prm.range?.[0] ?? 0, prm.range?.[1] ?? 0x7fff);
    case "hz": return clampWord(Math.round(v), prm.range?.[0] ?? 0, prm.range?.[1] ?? 0xffff);
    case "off": return v === 0 ? 0 : clampWord(Math.round(v), prm.range?.[0] ?? 0, prm.range?.[1] ?? 0xffff);
    case "knob":
    case "rate": return clampWord(Math.round(v), 0, 100);
    default: return clampWord(Math.round(v), 0, 0xffff);
  }
}

const clampWord = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function friendly(prm: catalog.Param, raw: number): number | string {
  switch (prm.kind) {
    case "ms": return raw & 0x8000 ? catalog.syncLabel(raw & 0x7fff).replace("♩ ", "") : raw;
    case "rate": return raw > 100 ? catalog.syncLabel(raw - 101).replace("♩ ", "") : raw;
    case "eqGain": return (raw - 32) / 2;
    case "eqQ": return (raw + 2) / 10;
    case "pitch": return raw / 10 - 12;
    case "simGain": return (raw - 120) / 10;
    case "midShift": return raw + 200;
    case "off": return raw === 0 ? "off" : raw;
    default: return raw;
  }
}

const UNITS: Partial<Record<catalog.ParamKind, string>> = { ms: "ms (or sync note)", hz: "Hz", off: "Hz (0/off disables)", eqGain: "dB", eqQ: "Q", rate: "0-100 (or sync note)", pitch: "semitones", simGain: "dB", midShift: "Hz" };

/** Visible parameters of a module with labels, friendly values and raw words. */
export function describeParams(m: PrimeModule) {
  const model = modelOf(m);
  const out: { label: string; value: number | string; unit?: string; raw: number; word: number }[] = [];
  for (let n = 0; 2 + n < m.words.length; n++) {
    const prm = catalog.param(m.type, model, n);
    if (prm.kind === "unknown") break;
    out.push({ label: prm.label, value: friendly(prm, m.words[2 + n]), unit: UNITS[prm.kind], raw: m.words[2 + n], word: 2 + n });
  }
  return out;
}

/** Model label; user slots (Samples tab) show the stored sample's name once list_samples has read it. */
export function modelText(type: number, model: number): string {
  const fileType = SAMPLE_FILE_FOR_MODULE[type];
  if (fileType === undefined || model < USER_MODEL_BASE) return catalog.modelLabel(type, model);
  const slot = session.device.sampleSlots.get(fileType)?.find((x) => x.id === model - USER_MODEL_BASE + 1);
  if (!slot) return catalog.modelLabel(type, model);
  return `${String(model + 1).padStart(2, "0")} ${slot.empty || !slot.name ? `User ${slot.id} (empty)` : stripNamMarker(slot.name)}`;
}

export function describeModule(m: PrimeModule) {
  const model = modelOf(m);
  return {
    slot: m.slot,
    type: catalog.typeName(m.type),
    model: model === undefined ? undefined : modelText(m.type, model),
    model_id: model,
    enabled: isEnabled(m),
    params: describeParams(m),
  };
}

export const describeChain = (modules: PrimeModule[]) => modules.filter((m) => !isEmpty(m)).map(describeModule);

export function chainSummary(modules: { type: number; words: number[] }[]): string {
  return modules.map((m) => `${catalog.typeName(m.type)} ${catalog.modelLabel(m.type, m.words[1] ?? 0)}${m.words[0] ? "" : " (off)"}`).join(" → ");
}

/** Applies named params (case-insensitive label match) and raw word overrides to a copy of the module. */
export function applyParams(m: PrimeModule, params: Record<string, number | string> = {}, rawWords: Record<string, number> = {}, enabled?: boolean): PrimeModule {
  const words = m.words.slice();
  const model = modelOf(m);
  if (enabled !== undefined) words[0] = enabled ? 1 : 0;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const labels = describeParams(m);
  for (const [key, value] of Object.entries(params)) {
    const hit = labels.find((p) => norm(p.label) === norm(key));
    if (!hit) throw new PedalError(`${catalog.typeName(m.type)} ${catalog.modelLabel(m.type, model ?? 0)} has no parameter "${key}". Parameters: ${labels.map((p) => p.label).join(", ")}`);
    words[hit.word] = encodeParam(catalog.param(m.type, model, hit.word - 2), value);
  }
  for (const [idx, value] of Object.entries(rawWords)) {
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 2 || i >= words.length) throw new PedalError(`raw_words index ${idx} out of range (2…${words.length - 1})`);
    words[i] = clampWord(Math.round(value), 0, 0xffff);
  }
  return { ...m, words };
}
