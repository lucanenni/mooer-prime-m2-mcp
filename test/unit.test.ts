import { describe, expect, it } from "vitest";
import { MIXER_MAX, channelWrites, clamp, dbToEq, dbToLevel, eqToDb, inputGainStep, levelToDb, masterWrites, panName } from "../src/settings";
import { applyParams, encodeParam, resolveModel, resolveType } from "../src/effects";
import { wavSamples } from "../src/wav";
import * as catalog from "../src/protocol/catalog";
import { defaultWords } from "../src/protocol/catalog";
import { PedalError } from "../src/session";

describe("settings conversions", () => {
  it("maps mixer dB to raw and back", () => {
    expect(dbToLevel(0)).toBe(60);
    expect(levelToDb(60)).toBe(0);
    expect(dbToLevel(-100)).toBe(0);
    expect(dbToLevel(100)).toBe(MIXER_MAX);
    expect(levelToDb(dbToLevel(-6.5))).toBe(-6.5);
  });
  it("maps EQ dB to raw and back, clamped", () => {
    expect(dbToEq(0)).toBe(24);
    expect(eqToDb(24)).toBe(0);
    expect(dbToEq(-50)).toBe(0);
    expect(dbToEq(50)).toBe(48);
  });
  it("names pan positions", () => {
    expect(panName(50)).toBe("C");
    expect(panName(30)).toBe("L20");
    expect(panName(75)).toBe("R25");
  });
  it("clamps", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
  it("snaps input gain to the nearest step", () => {
    expect(inputGainStep("off")).toBe(0);
    expect(inputGainStep(-7)).toBe(8); // -5 is the closest
    expect(inputGainStep(0)).toBe(9);
    expect(inputGainStep(100)).toBe(21);
  });
});

describe("byte writes", () => {
  it("channelWrites encodes on/off inverted, level and pan", () => {
    expect(channelWrites({})).toEqual([]);
    expect(channelWrites({ channel: "vocal", on: false, level_db: 0, pan: -20 })).toEqual([[51, 1], [52, 60], [89, 30]]);
    expect(channelWrites({ channel: "usb", on: true, pan: 999 })).toEqual([[31, 0], [91, 100]]);
  });
  it("masterWrites mirrors left to right in mono", () => {
    const s = new Uint8Array(99);
    expect(masterWrites({ mode: "mono", level_db: -6 }, s)).toEqual([[39, 0], [37, 48], [38, 48]]);
  });
  it("masterWrites links channels when stereo and linked", () => {
    const s = new Uint8Array(99);
    s[39] = 1;
    s[36] = 1;
    expect(masterWrites({ left_db: -10 }, s)).toEqual([[37, 40], [38, 40]]);
    expect(masterWrites({ left_db: -10, right_db: 0 }, s)).toEqual([[37, 40], [38, 60]]);
  });
  it("masterWrites keeps channels independent when unlinked", () => {
    const s = new Uint8Array(99);
    s[39] = 1;
    expect(masterWrites({ right_db: -10 }, s)).toEqual([[38, 40]]);
  });
});

describe("effect lookup", () => {
  it("resolves types by name or id", () => {
    expect(resolveType("drive")).toBe(resolveType("Drive"));
    expect(resolveType(resolveType("Delay"))).toBe(resolveType("Delay"));
    expect(() => resolveType("nonsense")).toThrow(PedalError);
    expect(() => resolveType(9999)).toThrow(PedalError);
  });
  it("resolves models by id, name or label", () => {
    const drive = resolveType("Drive");
    const id = resolveModel(drive, "808");
    expect(resolveModel(drive, id)).toBe(id);
    expect(resolveModel(drive, catalog.modelLabel(drive, id))).toBe(id);
    expect(() => resolveModel(drive, "zzzz")).toThrow(/No Drive model/);
    expect(() => resolveModel(drive, 99999)).toThrow(PedalError);
  });
});

describe("encodeParam", () => {
  const p = (kind: catalog.ParamKind, extra: Partial<catalog.Param> = {}) => ({ label: "X", kind, ...extra }) as catalog.Param;
  it("encodes units", () => {
    expect(encodeParam(p("eqGain"), 0)).toBe(32);
    expect(encodeParam(p("eqGain"), 100)).toBe(64);
    expect(encodeParam(p("pitch"), 0)).toBe(120);
    expect(encodeParam(p("simGain"), 0)).toBe(120);
    expect(encodeParam(p("midShift"), 200)).toBe(0);
    expect(encodeParam(p("knob"), 250)).toBe(100);
    expect(encodeParam(p("knob"), -5)).toBe(0);
  });
  it("encodes sync notes only on syncable parameters", () => {
    expect(encodeParam(p("ms", { label: "Time" }), "1/8D") & 0x8000).toBe(0x8000);
    expect(encodeParam(p("rate"), "1/4")).toBeGreaterThan(100);
    expect(() => encodeParam(p("knob"), "1/8D")).toThrow(PedalError);
    expect(() => encodeParam(p("ms", { label: "Time" }), "bogus")).toThrow(PedalError);
  });
  it("accepts off only where allowed", () => {
    expect(encodeParam(p("off"), "off")).toBe(0);
    expect(() => encodeParam(p("knob"), "off")).toThrow(PedalError);
  });
});

describe("applyParams", () => {
  const drive = resolveType("Drive");
  const mod = () => ({ slot: 1, type: drive, words: defaultWords(drive, resolveModel(drive, "808")) });
  it("does not mutate its input and applies enabled", () => {
    const m = mod();
    const before = m.words.slice();
    const out = applyParams(m, {}, {}, false);
    expect(m.words).toEqual(before);
    expect(out.words[0]).toBe(0);
    expect(applyParams(m, {}, {}, true).words[0]).toBe(1);
  });
  it("matches labels case- and punctuation-insensitively", () => {
    expect(applyParams(mod(), { " gain ": 33 }).words[2]).toBe(33);
  });
  it("rejects unknown parameters and bad raw indices", () => {
    expect(() => applyParams(mod(), { Nope: 1 })).toThrow(/no parameter/);
    expect(() => applyParams(mod(), {}, { "0": 1 })).toThrow(/out of range/);
    expect(() => applyParams(mod(), {}, { "999": 1 })).toThrow(/out of range/);
    expect(applyParams(mod(), {}, { "3": 70000 }).words[3]).toBe(0xffff);
  });
});

describe("wavSamples", () => {
  const wav = (bits: number, channels: number, data: number[], audioFormat = 1) => ({
    bytes: Uint8Array.from(data),
    info: { audioFormat, channels, sampleRate: 44100, bits, dataOffset: 0, dataSize: data.length } as never,
  });
  it("reads 8-bit unsigned", () => {
    const { bytes, info } = wav(8, 1, [128, 255, 0]);
    const s = wavSamples(bytes, info);
    expect(s.frames).toBe(3);
    expect(s.sample(0, 0)).toBe(0);
    expect(s.sample(2, 0)).toBe(-1);
  });
  it("reads 16-bit and repeats mono on both channels", () => {
    const { bytes, info } = wav(16, 1, [0x00, 0x40, 0x00, 0xc0]);
    const s = wavSamples(bytes, info);
    expect(s.sample(0, 1)).toBe(0.5);
    expect(s.sample(1, 0)).toBe(-0.5);
  });
  it("reads signed 24-bit stereo", () => {
    const { bytes, info } = wav(24, 2, [0, 0, 0x40, 0, 0, 0xc0]);
    const s = wavSamples(bytes, info);
    expect(s.frames).toBe(1);
    expect(s.sample(0, 0)).toBe(0.5);
    expect(s.sample(0, 1)).toBe(-0.5);
  });
  it("reads 32-bit PCM and float", () => {
    const f = new Uint8Array(new Float32Array([0.25]).buffer);
    expect(wavSamples(f, wav(32, 1, [...f], 3).info).sample(0, 0)).toBe(0.25);
    const i = Uint8Array.from([0, 0, 0, 0x40]);
    expect(wavSamples(i, wav(32, 1, [...i]).info).sample(0, 0)).toBe(0.5);
  });
  it("rejects unsupported formats", () => {
    expect(() => wavSamples(new Uint8Array(4), wav(16, 1, [0, 0, 0, 0], 2).info)).toThrow(PedalError);
    expect(() => wavSamples(new Uint8Array(4), wav(12, 1, [0, 0, 0, 0]).info)).toThrow(PedalError);
  });
});
