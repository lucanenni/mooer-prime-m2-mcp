import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAB_IR_SAMPLES, SAMPLE_FRAME_BYTES, SAMPLE_TYPES, checkSampleFile, dataSection, packCabIr, readWav } from "../protocol/loopFile";
import { NAM_A2_NAME_MARKER, namA2Payload, stripNamMarker } from "../protocol/nam";
import { session, PedalError } from "../session";
import { wavSamples } from "../wav";
import { readFile, safeName, tool, writeFile } from "./util";

const KINDS = { drive: 2, "pre-amp": 3, "entire-amp": 4, cab: 1 } as const;
const kind = z.enum(["drive", "pre-amp", "entire-amp", "cab"]);
const slot = z.number().int().min(1).max(10);
const info = (k: keyof typeof KINDS) => SAMPLE_TYPES.find((t) => t.type === KINDS[k])!;

async function readList(d: Parameters<Parameters<typeof tool>[5]>[1], type: number) {
  d.sampleSlots.delete(type);
  d.readSampleList(type);
  await session.waitFor(() => d.sampleSlots.has(type), 5000, "the sample list");
  return d.sampleSlots.get(type)!;
}

/** Bytes to store for a file: NAM A2 captures, a WAV cab IR (first 1024 samples), or raw container data. */
function sampleData(type: number, path: string): { data: Uint8Array; marker: boolean } {
  const bytes = readFile(path);
  const problem = checkSampleFile(type, path.split("/").pop()!, bytes);
  if (problem) throw new PedalError(problem);
  if (/\.nam$/i.test(path)) {
    if (type !== 3 && type !== 4) throw new PedalError("NAM captures go to pre-amp or entire-amp slots.");
    const nam = namA2Payload(new TextDecoder().decode(bytes));
    if ("error" in nam) throw new PedalError(nam.error);
    return { data: nam.data, marker: true };
  }
  if (type === 1 && /\.wav$/i.test(path)) {
    const wav = readWav(bytes);
    if (!wav) throw new PedalError("Not a WAV file.");
    const { frames, sample } = wavSamples(bytes, wav);
    const ir = new Float32Array(Math.min(frames, CAB_IR_SAMPLES));
    for (let i = 0; i < ir.length; i++) ir[i] = sample(i, 0);
    return { data: packCabIr(ir), marker: false };
  }
  const data = dataSection(bytes);
  if (type === 1 && data.length !== CAB_IR_SAMPLES * 4) throw new PedalError(`A cab IR is ${CAB_IR_SAMPLES * 4} bytes; this file has ${data.length}.`);
  return { data, marker: false };
}

export function registerSampleTools(server: McpServer) {
  tool(server, "list_samples", "Samples stored on the pedal (USB): cab IRs, drive, pre-amp and entire-amp files, 10 slots each. Without kind, all four lists.", { kind: kind.optional() }, { readOnly: true }, async ({ kind: k }, d) => {
    const kinds = k ? [k] : (Object.keys(KINDS) as (keyof typeof KINDS)[]);
    const out: Record<string, unknown> = {};
    for (const name of kinds) {
      const slots = await readList(d, KINDS[name]);
      out[name] = Array.from({ length: 10 }, (_, i) => {
        const s = slots.find((x) => x.id === i + 1);
        return { slot: i + 1, empty: !s || s.empty, name: s && !s.empty ? stripNamMarker(s.name) : undefined, nam_a2: s?.name.startsWith(NAM_A2_NAME_MARKER) || undefined, bytes: s && !s.empty ? s.length : undefined };
      });
    }
    return out;
  });

  tool(server, "export_sample", "Save a sample slot to a file (USB): .gir / .gnr / .preamp / .entire raw data.", { kind, slot, file: z.string().optional() }, { readOnly: true }, async ({ kind: k, slot: id, file }, d) => {
    const t = info(k);
    const f = await d.transfer(() => d.readFile(t.type, id));
    return { file: writeFile(file ?? `samples/${k}-${id}-${safeName(stripNamMarker(f.name))}.${t.extension}`, f.data), name: stripNamMarker(f.name), bytes: f.data.length };
  });

  tool(server, "import_sample", "Upload a file into a sample slot (USB), replacing its content (the old file is exported to backups first). Accepts: cab = .wav (first 1024 samples) or .gir; drive = .gnr/.drive; pre-amp = .preamp or NAM A2 .nam; entire-amp = .entire or NAM A2 .nam. Older (non-A2) NAM captures are not supported. Experimental: only NAM A2 into entire-amp is verified on hardware.", {
    kind,
    slot,
    file: z.string(),
    name: z.string().max(40).optional(),
    confirm: z.boolean().describe("Must be true"),
  }, { destructive: true }, async ({ kind: k, slot: id, file, name, confirm }, d) => {
    if (!confirm) throw new PedalError("confirm must be true: this replaces the file in that slot.");
    const t = info(k);
    const { data, marker } = sampleData(t.type, file);
    const current = (await readList(d, t.type)).find((s) => s.id === id);
    let backup: string | undefined;
    if (current && !current.empty) {
      const old = await d.transfer(() => d.readFile(t.type, id));
      backup = writeFile(`backups/before-import-${k}-${id}-${safeName(stripNamMarker(old.name))}.${t.extension}`, old.data);
    }
    const base = (name ?? file.split("/").pop()!.replace(/\.[^.]+$/, "")).replace(/[^\x20-\x7e]+/g, "_") || "untitled";
    const stored = marker ? NAM_A2_NAME_MARKER + base.slice(0, 50 - NAM_A2_NAME_MARKER.length) : base.slice(0, 50);
    await d.transfer(() => d.writeFile(t.type, id, stored, data, SAMPLE_FRAME_BYTES));
    return { imported: stripNamMarker(stored), kind: k, slot: id, bytes: data.length, backup };
  });

  tool(server, "delete_sample", "Delete a sample slot's file (USB). The file is exported to backups first.", { kind, slot, confirm: z.boolean().describe("Must be true") }, { destructive: true }, async ({ kind: k, slot: id, confirm }, d) => {
    if (!confirm) throw new PedalError("confirm must be true to delete the file.");
    const t = info(k);
    const current = (await readList(d, t.type)).find((s) => s.id === id);
    if (!current || current.empty) throw new PedalError(`${k} slot ${id} is already empty.`);
    const old = await d.transfer(() => d.readFile(t.type, id));
    const backup = writeFile(`backups/before-delete-${k}-${id}-${safeName(stripNamMarker(old.name))}.${t.extension}`, old.data);
    await d.transfer(() => d.deleteFile(t.type, id, current.name));
    d.clearSampleSlot(t.type, id);
    return { deleted: stripNamMarker(current.name), backup };
  });

  tool(server, "set_bluetooth_name", "Rename the pedal's Bluetooth name (1-17 printable ASCII characters in all, including the fixed \"M2\" prefix the official app keeps). Takes effect after the pedal is switched off and on. Unverified.", { name: z.string().min(1).max(17) }, { idempotent: true }, async ({ name }, d) => {
    const before = d.bluetoothName;
    if (!d.setBluetoothName(name)) throw new PedalError("Use 1 to 17 plain printable ASCII characters.");
    await session.settle();
    return { before, after: d.bluetoothName, note: "Switch the pedal off and on to apply." };
  });
}
