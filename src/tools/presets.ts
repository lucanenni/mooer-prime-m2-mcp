import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as catalog from "../protocol/catalog";
import { CloudPreset, decodeBank, encodeBank, type BankEntry } from "../protocol/cloudPreset";
import { slotLabel, isEmpty, type PrimeModule } from "../protocol/models";
import { session, PedalError } from "../session";
import { applyParams, chainSummary, describeChain, resolveModel, resolveType } from "../effects";
import { decodeSettings } from "../settings";
import { DATA_DIR, readFile, safeName, stamp, tool, writeFile } from "./util";

const slotNo = z.number().int().min(1).max(80);
const typeArg = z.union([z.string(), z.number()]).describe('Effect type name ("Drive", "Pre-Amp", "Cab", "Dyna", "Filter", "Mod", "Delay", "Reverb", "EQ", "Guitar Sim", "Entire Amp") or number');
const modelArg = z.union([z.string(), z.number()]).describe('Model name (unique substring, e.g. "808") or wire model id from list_effect_catalog');

/** Effect spec used to build whole presets offline. */
export const effectSpec = z.object({
  type: typeArg,
  model: modelArg,
  enabled: z.boolean().optional(),
  params: z.record(z.union([z.number(), z.string()])).optional().describe("Parameter label -> value in its unit (see list_effect_catalog)"),
});

export function buildCloud(name: string, bpm: number, effects: z.infer<typeof effectSpec>[]): CloudPreset {
  if (effects.length > catalog.MAX_MODULES) throw new PedalError(`At most ${catalog.MAX_MODULES} effects per preset.`);
  const modules = effects.map((e, i) => {
    const type = resolveType(e.type);
    const model = resolveModel(type, e.model);
    const base: PrimeModule = { slot: i + 1, type, words: catalog.defaultWords(type, model) };
    const m = applyParams(base, e.params, {}, e.enabled);
    return { type: m.type, words: m.words };
  });
  return CloudPreset.fromPreset(name, bpm, modules);
}

/** Backs up stored preset `index` into the data directory; returns the file, or null if it could not be read. */
export async function backupSlot(index: number, why: string): Promise<string | null> {
  const d = session.device;
  try {
    const preset = await d.transfer(() => d.readStoredPreset(index));
    return writeFile(`backups/${stamp()}-${why}-${slotLabel(index)}-${safeName(preset.name)}.preset`, preset.fileData);
  } catch {
    return null;
  }
}

async function readPresetsForListing() {
  const d = session.device;
  await session.waitFor(() => d.scanRemaining === 0, 60_000, "the preset scan");
  await session.settle();
}

export function registerPresetTools(server: McpServer) {
  tool(server, "get_status", "Connection and pedal status: firmware, serial, battery, active preset, tempo, link type, and pending warnings. Connects to the pedal if needed.", {}, { readOnly: true }, async (_a, d) => ({
    connected: true,
    link: d.link,
    firmware: d.firmware,
    serial: d.serial,
    battery_percent: d.battery,
    active_preset: d.activePresetIndex,
    active_preset_label: d.activePresetIndex ? slotLabel(d.activePresetIndex) : undefined,
    active_preset_name: d.preset?.name,
    tempo_bpm: d.tempo,
    data_dir: DATA_DIR,
    demo: session.demo,
    warning: d.connectionIssue,
  }));

  tool(server, "list_presets", "List the 80 presets (number, bank label such as 0A, name). With with_chains, also each preset's effect chain.", { with_chains: z.boolean().optional().describe("Include effect chains (waits for the background scan, a few seconds)") }, { readOnly: true }, async ({ with_chains }, d) => {
    if (with_chains) await readPresetsForListing();
    return Array.from({ length: 80 }, (_, i) => {
      const n = i + 1;
      const cached = d.presetCache.get(n);
      return {
        preset: n,
        label: slotLabel(n),
        name: d.presetNames.get(n) ?? "",
        active: n === d.activePresetIndex || undefined,
        ...(with_chains && cached ? { chain: chainSummary(cached.modules.filter((m) => !isEmpty(m))) } : {}),
      };
    });
  });

  tool(server, "get_preset", "Full effect chain of a preset with every parameter in real units. Defaults to the active preset, where it shows the live edit buffer (including unsaved edits); other presets show the stored version.", { preset: slotNo.optional() }, { readOnly: true }, async ({ preset }, d) => {
    const n = preset ?? d.activePresetIndex!;
    if (n === d.activePresetIndex) {
      await session.reloadActive();
      const p = d.preset!;
      return { preset: n, label: slotLabel(n), name: p.name, tempo_bpm: d.tempo, source: "edit buffer", effects: describeChain(p.modules) };
    }
    let cached = d.presetCache.get(n);
    if (!cached) {
      d.refreshPreset(n);
      await session.waitFor(() => d.presetCache.has(n), 10_000, `preset ${n}`);
      cached = d.presetCache.get(n);
    }
    return { preset: n, label: slotLabel(n), name: cached!.name, source: "stored", effects: describeChain(cached!.modules) };
  });

  tool(server, "select_preset", "Switch the pedal to preset 1-80. Unsaved edits to the current preset are discarded.", { preset: slotNo }, { idempotent: true }, async ({ preset }, d) => {
    d.selectPreset(preset);
    await session.waitFor(() => d.activePresetIndex === preset && d.preset?.index === preset, 8000, "the preset change");
    await session.settle();
    return { active_preset: preset, label: slotLabel(preset), name: d.preset?.name, effects: chainSummary(d.preset!.modules.filter((m) => !isEmpty(m))) };
  });

  tool(server, "save_preset", "Save the active preset's edit buffer into a slot (default: the current one), optionally renaming it. The previous content of the target slot is backed up to the data directory first.", {
    preset: slotNo.optional().describe("Target slot; default = active preset"),
    name: z.string().max(20).optional().describe("Preset name (ASCII, max 20); default = current name"),
  }, { destructive: true }, async ({ preset, name }, d) => {
    const target = preset ?? d.activePresetIndex!;
    const finalName = name ?? d.preset?.name ?? d.presetNames.get(target) ?? "Preset";
    const backup = session.demo ? null : await backupSlot(target, "before-save");
    d.savePreset(target, finalName);
    await session.waitFor(() => d.activePresetIndex === target && d.preset?.index === target, 8000, "the save");
    await session.settle();
    return { saved_to: target, label: slotLabel(target), name: d.presetNames.get(target), backup };
  });

  tool(server, "copy_preset", "Copy the stored version of one preset slot onto another (USB). The target's previous content is backed up and the write is verified.", {
    from: slotNo,
    to: slotNo,
  }, { destructive: true }, async ({ from, to }, d) => {
    if (from === to) throw new PedalError("from and to are the same slot.");
    const backup = await backupSlot(to, "before-copy");
    await d.transfer(async () => {
      const src = await d.readStoredPreset(from);
      await d.restoreStoredPreset(to, src);
    });
    d.refreshPreset(to);
    await session.settle();
    return { copied: `${slotLabel(from)} → ${slotLabel(to)}`, name: d.presetNames.get(to), backup };
  });

  tool(server, "create_preset", "Build a whole preset from a list of effects in one step. Write it to a pedal slot (replaces that slot, previous content backed up), save it as a .preset file, or both. Parameters not given keep sensible defaults.", {
    name: z.string().max(20),
    effects: z.array(effectSpec).max(catalog.MAX_MODULES).describe("Chain in signal order"),
    bpm: z.number().int().min(40).max(260).optional(),
    slot: slotNo.optional().describe("Write to this pedal slot"),
    file: z.string().optional().describe("Also/only save a Mooer Studio .preset file here"),
    confirm: z.boolean().optional().describe("Required when writing to a slot"),
  }, { destructive: true }, async ({ name, effects, bpm, slot, file, confirm }, d) => {
    const cloud = buildCloud(name, bpm ?? 120, effects);
    const out: Record<string, unknown> = { name, chain: chainSummary(cloud.modules) };
    if (file) out.file = writeFile(file, cloud.fileData);
    if (slot !== undefined) {
      if (!confirm) throw new PedalError(`This replaces preset ${slotLabel(slot)} “${d.presetNames.get(slot) ?? ""}”. Call again with confirm: true.`);
      out.backup = await backupSlot(slot, "before-create");
      await d.transfer(() => d.restoreStoredPreset(slot, cloud));
      d.refreshPreset(slot);
      await session.settle();
      out.written_to = slotLabel(slot);
    }
    if (!file && slot === undefined) out.note = "Nothing written: pass slot and/or file.";
    return out;
  });

  tool(server, "backup_preset", "Export the stored version of one preset to a Mooer Studio .preset file (USB).", {
    preset: slotNo,
    file: z.string().optional().describe("Output path; default under the data directory"),
  }, { readOnly: true }, async ({ preset, file }, d) => {
    const p = await d.transfer(() => d.readStoredPreset(preset));
    return { file: writeFile(file ?? `presets/${slotLabel(preset)}-${safeName(p.name)}.preset`, p.fileData), name: p.name, chain: chainSummary(p.modules) };
  });

  tool(server, "backup_all_presets", "Export all 80 presets to one bank JSON file (USB, takes a while).", { file: z.string().optional() }, { readOnly: true }, async ({ file }, d) => {
    const entries: BankEntry[] = [];
    await d.transfer(async () => {
      for (let i = 1; i <= 80; i++) {
        const preset = await d.readStoredPreset(i);
        entries.push({ index: i, name: preset.name, preset });
      }
    });
    return { file: writeFile(file ?? `bank-${stamp()}.json`, encodeBank(entries)), presets: entries.length };
  });

  tool(server, "restore_preset", "Write a .preset file, or one preset of a bank JSON, into a pedal slot (USB). Replaces the slot: the previous content is backed up and the result is read back and verified.", {
    file: z.string().describe(".preset or bank .json file"),
    preset: slotNo.describe("Target slot"),
    bank_index: slotNo.optional().describe("For bank files: which preset of the bank (default = same number as the target)"),
    confirm: z.boolean().describe("Must be true"),
  }, { destructive: true }, async ({ file, preset, bank_index, confirm }, d) => {
    if (!confirm) throw new PedalError("confirm must be true to replace a preset slot.");
    const bytes = readFile(file);
    let cloud: CloudPreset | null;
    if (bytes[0] === 0x7b) {
      const bank = decodeBank(new TextDecoder().decode(bytes));
      if (!bank) throw new PedalError("Not a valid bank file.");
      const entry = bank.find((e) => e.index === (bank_index ?? preset));
      if (!entry) throw new PedalError(`Bank has no preset ${bank_index ?? preset}.`);
      cloud = entry.preset;
    } else cloud = CloudPreset.fromFile(bytes);
    if (!cloud) throw new PedalError("Not a valid .preset file.");
    if (!cloud.crcIsValid) throw new PedalError("The preset file fails its CRC check; refusing to write it.");
    const backup = await backupSlot(preset, "before-restore");
    await d.transfer(() => d.restoreStoredPreset(preset, cloud!));
    d.refreshPreset(preset);
    await session.settle();
    return { restored: cloud.name, to: slotLabel(preset), backup, verified: true };
  });

  tool(server, "audition_preset", "Play a preset on the pedal without storing it (USB). Source: a .preset file, or an effects list. Call end_audition to leave it.", {
    file: z.string().optional(),
    name: z.string().max(20).optional(),
    effects: z.array(effectSpec).max(catalog.MAX_MODULES).optional(),
  }, {}, async ({ file, name, effects }, d) => {
    let cloud: CloudPreset | null;
    if (file) cloud = CloudPreset.fromFile(readFile(file));
    else if (effects) cloud = buildCloud(name ?? "Audition", 120, effects);
    else throw new PedalError("Pass file or effects.");
    if (!cloud) throw new PedalError("Not a valid .preset file.");
    await d.transfer(() => d.writeStoredPreset(0, cloud!));
    return { auditioning: cloud.name, chain: chainSummary(cloud.modules), note: "Nothing is stored. Call end_audition when done." };
  });

  tool(server, "end_audition", "Leave audition mode and return to the stored preset.", {}, { idempotent: true }, async (_a, d) => {
    await d.transfer(() => d.endAudition());
    d.refreshPreset(d.activePresetIndex!);
    await session.settle();
    return { ok: true };
  });

  tool(server, "get_settings", "All pedal-wide settings decoded in real units: mixer, vocal FX, global (CabSim, EQ, input gain), tuner, drum, looper, display/RGB.", {}, { readOnly: true }, async (_a, d) => decodeSettings(d.systemStateBytes!));
}
