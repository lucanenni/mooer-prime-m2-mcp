import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { session, PedalError } from "../session";
import { MIXER_MAX, RGB_COLORS, SLEEP_MINUTES, channelWrites, clamp, dbToEq, decodeSettings, inputGainStep, masterWrites, type ByteWrites } from "../settings";
import { tool } from "./util";

/** Writes bytes into the system state (one full-state write) and returns the decoded result. */
async function apply(d: Parameters<Parameters<typeof tool>[5]>[1], writes: ByteWrites) {
  if (!writes.length) throw new PedalError("Nothing to change: pass at least one setting.");
  // a late state read can overwrite the bytes just written, so check and write again if needed
  for (let attempt = 0; attempt < 3; attempt++) {
    const have = d.systemStateBytes;
    const todo = attempt === 0 ? writes : writes.filter(([i, v]) => have?.[i] !== v);
    if (!todo.length) break;
    for (const [i, v] of todo) d.setSystemByte(i, v);
    await session.settle();
  }
  return decodeSettings(d.systemStateBytes!);
}

const db = z.number().min(-30).max(MIXER_MAX / 2 - 30);
const eqDb = z.number().min(-12).max(12);
const pct = z.number().int().min(0).max(100);
const bool = z.boolean();

export function registerSettingsTools(server: McpServer) {
  tool(server, "set_mixer", "Mixer: per-channel on/off, level (dB, -30…+6) and pan (-50 left … +50 right; pan only has effect with a stereo master), plus the master section. Settings are applied to the pedal immediately.", {
    channels: z.array(z.object({
      channel: z.enum(["instrument", "vocal", "bluetooth", "usb"]),
      on: bool.optional(),
      level_db: db.optional(),
      pan: z.number().min(-50).max(50).optional(),
    })).optional(),
    master: z.object({
      mode: z.enum(["mono", "stereo"]).optional(),
      mute: bool.optional(),
      level_db: db.optional().describe("Both sides"),
      left_db: db.optional(),
      right_db: db.optional(),
      link_lr: bool.optional(),
      three_d: bool.optional().describe("3D effect, stereo only"),
    }).optional(),
  }, { idempotent: true }, async ({ channels, master }, d) => {
    const s = d.systemStateBytes!;
    const writes = [...(channels ?? []).flatMap((c) => channelWrites(c)), ...(master ? masterWrites(master, s) : [])];
    return (await apply(d, writes)).mixer;
  });

  tool(server, "set_vocal_fx", "Vocal FX: compressor, EQ and reverb switches and values.", {
    comp: z.object({ on: bool.optional(), level: pct.optional(), sensitivity: pct.optional() }).optional(),
    eq: z.object({ on: bool.optional(), low_db: eqDb.optional(), mid_db: eqDb.optional(), high_db: eqDb.optional() }).optional(),
    reverb: z.object({ on: bool.optional(), mix: pct.optional(), decay: pct.optional(), time: pct.optional() }).optional(),
  }, { idempotent: true }, async ({ comp, eq, reverb }, d) => {
    const w: ByteWrites = [];
    const on = (i: number, v?: boolean) => v !== undefined && w.push([i, v ? 1 : 0]);
    const val = (i: number, v?: number) => v !== undefined && w.push([i, v]);
    if (comp) (on(53, comp.on), val(55, comp.level), val(57, comp.sensitivity));
    if (eq) {
      on(59, eq.on);
      for (const [i, v] of [[61, eq.low_db], [63, eq.mid_db], [65, eq.high_db]] as const) if (v !== undefined) w.push([i, dbToEq(v)]);
    }
    if (reverb) (on(67, reverb.on), val(69, reverb.mix), val(71, reverb.decay), val(73, reverb.time));
    return (await apply(d, w)).vocal_fx;
  });

  tool(server, "set_global", "Global settings: CabSim, input gain, global EQ (4 bands) and where the delay tempo comes from.", {
    cabsim: bool.optional(),
    input_gain_db: z.union([z.number().min(-60).max(6), z.literal("off")]).optional().describe("Snaps to the nearest hardware step: off, -60, -45, -35, -30, -25, -20, -10, -5, 0, then +0.5 steps to +6"),
    eq: z.object({ on: bool.optional(), hz100_db: eqDb.optional(), hz350_db: eqDb.optional(), hz1800_db: eqDb.optional(), hz4000_db: eqDb.optional() }).optional(),
    tempo_sync: z.enum(["preset", "global"]).optional().describe("Tempo source for delay (unverified byte)"),
  }, { idempotent: true }, async ({ cabsim, input_gain_db, eq, tempo_sync }, d) => {
    const w: ByteWrites = [];
    if (cabsim !== undefined) w.push([2, cabsim ? 1 : 0]);
    if (input_gain_db !== undefined) w.push([7, inputGainStep(input_gain_db)]);
    if (tempo_sync) w.push([98, tempo_sync === "global" ? 1 : 0]);
    if (eq) {
      if (eq.on !== undefined) w.push([49, eq.on ? 1 : 0]);
      for (const [i, v] of [[3, eq.hz100_db], [4, eq.hz350_db], [5, eq.hz1800_db], [6, eq.hz4000_db]] as const) if (v !== undefined) w.push([i, dbToEq(v)]);
    }
    return (await apply(d, w)).global;
  });

  tool(server, "set_tuner", "Tuner reference pitch (430-445 Hz) and whether the output is muted while tuning.", {
    reference_hz: z.number().int().min(430).max(445).optional(),
    mute: bool.optional(),
  }, { idempotent: true }, async ({ reference_hz, mute }, d) => {
    const w: ByteWrites = [];
    if (reference_hz !== undefined) w.push([44, reference_hz - 430]);
    if (mute !== undefined) w.push([45, mute ? 1 : 2]);
    return (await apply(d, w)).tuner;
  });

  tool(server, "set_drum", "Drum machine: pattern (1-60; names come from list_drum_patterns), tempo in BPM (also the delay tempo), sync with looper, and start/stop.", {
    pattern: z.number().int().min(1).max(60).optional(),
    tempo_bpm: z.number().min(40).max(260).optional(),
    sync_with_looper: bool.optional(),
    playing: bool.optional().describe("Start (true) or stop (false) the drum machine"),
  }, { idempotent: true }, async ({ pattern, tempo_bpm, sync_with_looper, playing }, d) => {
    const w: ByteWrites = [];
    if (pattern !== undefined) w.push([43, pattern - 1]);
    if (sync_with_looper !== undefined) w.push([46, sync_with_looper ? 1 : 0]);
    if (w.length) for (const [i, v] of w) d.setSystemByte(i, v);
    if (tempo_bpm !== undefined) d.setTempo(tempo_bpm);
    if (playing !== undefined) d.drumPlay(playing);
    if (!w.length && tempo_bpm === undefined && playing === undefined) throw new PedalError("Nothing to change.");
    await session.settle();
    return { ...decodeSettings(d.systemStateBytes!).drum, playing: d.drumPlaying };
  });

  tool(server, "list_drum_patterns", "Names of the drum patterns (number → name).", {}, { readOnly: true }, async (_a, d) =>
    Array.from({ length: Math.max(d.drumNames.length, 60) }, (_, i) => ({ pattern: i + 1, name: d.drumNames[i] || `Pattern ${i + 1}` })));

  tool(server, "set_display", "Display and power: brightness (5-55), auto shutdown, footswitch page mode, and the RGB light (dynamic mode, brightness, colour 1-9, static speed, colour sequence).", {
    brightness: z.number().int().min(5).max(55).optional(),
    auto_shutdown_minutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal("never")]).optional(),
    footswitch_page: bool.optional().describe("A = Page Down, B = Page Up"),
    rgb: z.object({
      dynamic: bool.optional(),
      brightness: z.enum(["soft", "bright"]).optional(),
      color: z.number().int().min(1).max(9).optional().describe(`Palette: ${RGB_COLORS.map((c, i) => `${i + 1}=${c}`).join(" ")}`),
      speed: z.enum(["I", "II", "III"]).optional().describe("Static speed (dynamic off)"),
      sequence: z.array(z.number().int().min(0).max(9)).max(9).optional().describe("Colour order, 0 = empty (unverified)"),
    }).optional(),
  }, { idempotent: true }, async ({ brightness, auto_shutdown_minutes, footswitch_page, rgb }, d) => {
    const w: ByteWrites = [];
    if (brightness !== undefined) w.push([75, clamp(brightness, 5, 55)]);
    if (auto_shutdown_minutes !== undefined) w.push([8, auto_shutdown_minutes === "never" ? 255 : SLEEP_MINUTES.includes(auto_shutdown_minutes) ? auto_shutdown_minutes : 255]);
    if (footswitch_page !== undefined) w.push([76, footswitch_page ? 1 : 0]);
    if (rgb) {
      if (rgb.dynamic !== undefined) w.push([94, rgb.dynamic ? 1 : 0]);
      if (rgb.brightness) w.push([96, rgb.brightness === "bright" ? 1 : 0]);
      if (rgb.color !== undefined) w.push([97, rgb.color]);
      if (rgb.speed) w.push([95, ["I", "II", "III"].indexOf(rgb.speed)]);
      rgb.sequence?.forEach((c, i) => w.push([77 + i, c]));
    }
    return (await apply(d, w)).display;
  });

  tool(server, "get_system_state", "Raw 99-byte system state (hex) next to the decoded settings, for exploring unmapped bytes.", {}, { readOnly: true }, async (_a, d) => {
    const s = d.systemStateBytes!;
    return { hex: Array.from(s, (b) => b.toString(16).padStart(2, "0")).join(" "), bytes: Array.from(s), decoded: decodeSettings(s) };
  });

  tool(server, "set_system_byte", "EXPERIMENTAL: write one raw byte of the system state (index 2-98; the preset byte and name are refused). Use restore_system_state to undo.", {
    index: z.number().int().min(2).max(98),
    value: z.number().int().min(0).max(255),
  }, { destructive: true }, async ({ index, value }, d) => {
    if (index >= 9 && index <= 28) throw new PedalError("Bytes 9-28 hold the pedal name; refused.");
    const before = d.systemStateBytes![index];
    d.setSystemByte(index, value);
    await session.settle();
    return { index, before, after: d.systemStateBytes![index] };
  });

  tool(server, "restore_system_state", "Write back the system state read when the session started (undoes settings changes made through this server).", {}, { destructive: true }, async (_a, d) => {
    d.restoreSystemState();
    await session.settle();
    return decodeSettings(d.systemStateBytes!);
  });

  tool(server, "factory_reset", "ERASES ALL presets and settings on the pedal and restores factory state. Back up first (backup_all_presets). Requires confirm = \"ERASE ALL\".", {
    confirm: z.string(),
  }, { destructive: true }, async ({ confirm }, d) => {
    if (confirm !== "ERASE ALL") throw new PedalError('Refused: pass confirm exactly "ERASE ALL". Run backup_all_presets first.');
    d.factoryReset();
    await session.settle(15_000).catch(() => undefined);
    return { reset: true, note: "The pedal rewrites its memory; the session restarts in about 8 seconds. Call get_status afterwards." };
  });
}
