import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(join(tmpdir(), "m2mcp-edge-"));
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0].text;
  return { error: !!r.isError, text, json: r.isError ? undefined : (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

beforeAll(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: { ...process.env as Record<string, string>, MOOER_DEMO: "1", MOOER_DATA_DIR: dir } }));
}, 30_000);
afterAll(async () => { await client.close(); });

describe("edge cases (demo pedal)", () => {
  it("rejects a 10th effect and out-of-range slots", async () => {
    for (let i = 0; i < 9; i++) expect((await call("add_effect", { type: "Drive", model: 1 })).error).toBe(false);
    expect((await call("get_preset")).json.effects).toHaveLength(9);
    expect((await call("add_effect", { type: "Drive", model: 1 })).error).toBe(true);
    expect((await call("edit_effect", { slot: 10, enabled: true })).error).toBe(true);
    expect((await call("remove_effect", { slot: 0 })).error).toBe(true);
    expect((await call("move_effect", { from: 1, to: 10 })).error).toBe(true);
    expect((await call("get_preset")).json.effects).toHaveLength(9);
  }, 60_000);

  it("rejects an empty slot and unknown names", async () => {
    await call("select_preset", { preset: 20 });
    expect((await call("add_effect", { type: "Nope", model: 1 })).error).toBe(true);
    expect((await call("add_effect", { type: "Drive", model: "zzzz" })).error).toBe(true);
    expect((await call("remove_effect", { slot: 5 })).error).toBe(true);
  }, 30_000);

  it("refuses corrupt or missing preset files", async () => {
    writeFileSync(join(dir, "junk.preset"), Buffer.from("not a preset"));
    expect((await call("restore_preset", { file: "junk.preset", preset: 3, confirm: true })).error).toBe(true);
    expect((await call("restore_preset", { file: "missing.preset", preset: 3, confirm: true })).error).toBe(true);
    writeFileSync(join(dir, "bad.json"), "{ nope");
    expect((await call("restore_preset", { file: "bad.json", preset: 3, confirm: true })).error).toBe(true);
  }, 30_000);

  it("refuses bad loop and sample imports", async () => {
    writeFileSync(join(dir, "junk.wav"), Buffer.from("RIFFxxxxnotawav"));
    expect((await call("import_loop", { loop: 1, file: "junk.wav", confirm: false })).error).toBe(true);
    expect((await call("import_loop", { loop: 1, file: "junk.wav", confirm: true })).error).toBe(true);
    expect((await call("import_loop", { loop: 1, file: "missing.wav", confirm: true })).error).toBe(true);
    expect((await call("import_sample", { kind: "cab", slot: 1, file: "junk.wav", confirm: true })).error).toBe(true);
    expect((await call("import_sample", { kind: "cab", slot: 1, file: "missing.wav", confirm: true })).error).toBe(true);
    writeFileSync(join(dir, "empty.gir"), Buffer.alloc(0));
    expect((await call("import_sample", { kind: "cab", slot: 1, file: "empty.gir", confirm: true })).text).toMatch(/empty/);
    writeFileSync(join(dir, "big.gir"), Buffer.alloc(8_000_001));
    expect((await call("import_sample", { kind: "cab", slot: 1, file: "big.gir", confirm: true })).text).toMatch(/MB/);
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]);
    writeFileSync(join(dir, "cab.wav"), wav);
    expect((await call("import_sample", { kind: "drive", slot: 1, file: "cab.wav", confirm: true })).text).toMatch(/Cab slots/);
  }, 30_000);

  it("shows user-slot models with the sample name", async () => {
    await call("select_preset", { preset: 30 });
    await call("list_samples", { kind: "cab" });
    const add = await call("add_effect", { type: "Cab", model: 200 });
    expect(add.error).toBe(false);
    expect(add.json.added.model).toMatch(/User 1/);
  }, 30_000);

  it("imports a cab sample and refuses to delete an empty slot", async () => {
    const wav = Buffer.alloc(44 + 2048 * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(44100, 24);
    wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2048 * 2, 40);
    writeFileSync(join(dir, "ir.wav"), wav);
    expect((await call("import_sample", { kind: "cab", slot: 2, file: "ir.wav", confirm: true })).error).toBe(false);
    // the simulated pedal cannot read sample files back, so only the empty-slot refusal is checked here
    expect((await call("delete_sample", { kind: "cab", slot: 3, confirm: true })).text).toMatch(/already empty/);
  }, 30_000);

  it("validates tool arguments before touching the pedal", async () => {
    expect((await call("select_preset", { preset: 0 })).error).toBe(true);
    expect((await call("set_bluetooth_name", { name: "" })).error).toBe(true);
    expect((await call("set_bluetooth_name", { name: "x".repeat(18) })).error).toBe(true);
    expect((await call("import_loop", { loop: 11, file: "a.wav", confirm: true })).error).toBe(true);
  }, 30_000);
});
