import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as catalog from "../protocol/catalog";
import { isEmpty } from "../protocol/models";
import { session, PedalError } from "../session";
import { SYNC_NOTES, applyParams, describeChain, describeModule, resolveModel, resolveType } from "../effects";
import { tool } from "./util";

const typeArg = z.union([z.string(), z.number()]).describe('Effect type name ("Drive", "Pre-Amp", "Cab", "Dyna", "Filter", "Mod", "Delay", "Reverb", "EQ", "Guitar Sim", "Entire Amp") or number');
const modelArg = z.union([z.string(), z.number()]).describe('Model name (unique substring, e.g. "808") or wire model id');
const slotArg = z.number().int().min(1).max(catalog.MAX_MODULES).describe("Position in the chain, 1 = first");

function used(d: { preset?: { modules: { type: number; words: unknown[] }[] } }) {
  return d.preset!.modules.filter((m) => !isEmpty(m as never)).length;
}

export function registerEffectTools(server: McpServer) {
  tool(server, "list_effect_catalog", "Effect types and models. Without arguments: the types with model counts. With type: every model (id and name) and the parameters of its default layout (label, unit, range). Parameters are edited by label with edit_effect. Models User 1…User 10 (ids 200…209) play the sample stored in that Samples slot (see list_samples).", {
    type: typeArg.optional(),
    model: modelArg.optional().describe("With type: show this model's exact parameter layout"),
  }, { readOnly: true }, async ({ type, model }) => {
    if (type === undefined) {
      return {
        max_effects_per_preset: catalog.MAX_MODULES,
        sync_notes: SYNC_NOTES,
        types: catalog.CATEGORY_ORDER.map((t) => ({ type: catalog.typeName(t), id: t, models: catalog.modelsOf(t).length })),
      };
    }
    const t = resolveType(type);
    const layout = (m: number) => {
      const out = [];
      for (let i = 0; catalog.param(t, m, i).kind !== "unknown"; i++) {
        const p = catalog.param(t, m, i);
        out.push({ label: p.label, kind: p.kind, range: p.range });
      }
      return out;
    };
    if (model !== undefined) {
      const m = resolveModel(t, model);
      return { type: catalog.typeName(t), model: catalog.modelLabel(t, m), model_id: m, params: layout(m) };
    }
    return { type: catalog.typeName(t), models: catalog.modelsOf(t).map((m) => ({ id: m, name: catalog.MODEL_NAMES[t]?.[m] ?? catalog.modelLabel(t, m) })), default_params: layout(catalog.modelsOf(t)[0]) };
  }, false);

  tool(server, "add_effect", "Add an effect to the active preset's edit buffer (not saved until save_preset). Appended to the chain unless position is given.", {
    type: typeArg,
    model: modelArg,
    position: slotArg.optional(),
    params: z.record(z.union([z.number(), z.string()])).optional(),
  }, {}, async ({ type, model, position, params }, d) => {
    const t = resolveType(type);
    const m = resolveModel(t, model);
    const count = used(d);
    if (count >= catalog.MAX_MODULES) throw new PedalError(`The chain already has ${catalog.MAX_MODULES} effects.`);
    const slot = count + 1;
    await place(d, slot, t, m);
    if (position !== undefined && position < slot) {
      d.moveModule(slot, position);
      await session.settle();
      await session.reloadActive();
    }
    const final = position !== undefined && position < slot ? position : slot;
    if (params) await editSlot(d, final, params);
    return { added: describeModule(d.preset!.modules.find((x) => x.slot === final)!), chain: describeChain(d.preset!.modules).map((x) => `${x.slot}. ${x.type} ${x.model}`) };
  });

  tool(server, "change_effect", "Replace the effect in a slot with another type/model (parameters reset to the new model's defaults).", {
    slot: slotArg,
    type: typeArg,
    model: modelArg,
    params: z.record(z.union([z.number(), z.string()])).optional(),
  }, {}, async ({ slot, type, model, params }, d) => {
    if (slot > used(d)) throw new PedalError(`Slot ${slot} is empty; the chain has ${used(d)} effects. Use add_effect.`);
    const t = resolveType(type);
    await place(d, slot, t, resolveModel(t, model));
    if (params) await editSlot(d, slot, params);
    return describeModule(d.preset!.modules.find((x) => x.slot === slot)!);
  });

  tool(server, "remove_effect", "Remove the effect in a slot; later effects move up.", { slot: slotArg }, { destructive: true }, async ({ slot }, d) => {
    if (slot > used(d)) throw new PedalError(`Slot ${slot} is empty.`);
    d.deleteModule(slot);
    await session.settle();
    await session.reloadActive();
    if (d.notice) throw new PedalError(d.notice);
    return { chain: describeChain(d.preset!.modules).map((x) => `${x.slot}. ${x.type} ${x.model}`) };
  });

  tool(server, "move_effect", "Move an effect from one chain position to another (like dragging it).", { from: slotArg, to: slotArg }, {}, async ({ from, to }, d) => {
    const n = used(d);
    if (from > n || to > n) throw new PedalError(`The chain has only ${n} effects.`);
    d.moveModule(from, to);
    await session.settle();
    await session.reloadActive();
    if (d.notice) throw new PedalError(d.notice);
    return { chain: describeChain(d.preset!.modules).map((x) => `${x.slot}. ${x.type} ${x.model}`) };
  });

  tool(server, "edit_effect", "Turn an effect on/off and/or set parameters by label in real units (dB, Hz, ms, semitones; delay time and mod rate also accept sync notes like \"1/8D\"). Edits go live immediately but are not stored until save_preset.", {
    slot: slotArg,
    enabled: z.boolean().optional(),
    params: z.record(z.union([z.number(), z.string()])).optional().describe('e.g. {"Gain": 70, "Time": "1/8D"}'),
    raw_words: z.record(z.number()).optional().describe("Advanced: raw 16-bit words by index (2 = first parameter)"),
  }, { idempotent: true }, async ({ slot, enabled, params, raw_words }, d) => {
    if (slot > used(d)) throw new PedalError(`Slot ${slot} is empty.`);
    await editSlot(d, slot, params, enabled, raw_words);
    return describeModule(d.preset!.modules.find((x) => x.slot === slot)!);
  });
}

async function place(d: Parameters<Parameters<typeof tool>[5]>[1], slot: number, type: number, model: number) {
  d.placeModule(slot, type, model);
  await session.settle();
  await session.reloadActive();
  const m = d.preset!.modules.find((x) => x.slot === slot);
  if (!m || m.type !== type || m.words[1] !== model) throw new PedalError(d.notice ?? `The pedal did not take ${catalog.typeName(type)} ${catalog.modelLabel(type, model)} (its DSP may be full).`);
}

async function editSlot(d: Parameters<Parameters<typeof tool>[5]>[1], slot: number, params?: Record<string, number | string>, enabled?: boolean, raw?: Record<string, number>) {
  const cur = d.preset!.modules.find((x) => x.slot === slot)!;
  d.updateModule(applyParams(cur, params, raw, enabled));
  await session.settle();
}
