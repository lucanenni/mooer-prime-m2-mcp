import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(join(tmpdir(), "m2mcp-"));
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

describe("mcp server (demo pedal)", () => {
  it("lists all tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["get_status", "list_presets", "get_preset", "select_preset", "save_preset", "add_effect", "edit_effect", "move_effect", "remove_effect", "set_mixer", "set_vocal_fx", "set_global", "set_tuner", "set_drum", "set_display", "set_looper", "looper_control", "backup_preset", "restore_preset", "create_preset", "factory_reset", "list_samples", "import_sample", "set_bluetooth_name"]) expect(names).toContain(n);
  });

  it("status and settings", async () => {
    expect((await call("get_status")).json.firmware).toContain("V1.5.0");
    const s = (await call("get_settings")).json;
    expect(s.mixer.instrument.level_db).toBe(0);
  });

  it("builds a chain, edits parameters in real units", async () => {
    expect((await call("add_effect", { type: "Drive", model: "808" })).error).toBe(false);
    const add = await call("add_effect", { type: "Delay", model: 1, params: { Time: "1/8D", Feedback: 40 } });
    expect(add.error).toBe(false);
    const p = (await call("get_preset")).json;
    expect(p.effects).toHaveLength(2);
    const delay = p.effects[1];
    expect(delay.params.find((x: { label: string }) => x.label === "Time").value).toBe("1/8D");
    await call("edit_effect", { slot: 1, enabled: false, params: { Gain: 77 } });
    const e = (await call("get_preset")).json.effects[0];
    expect(e.enabled).toBe(false);
    expect(e.params.find((x: { label: string }) => x.label === "Gain").value).toBe(77);
    expect((await call("edit_effect", { slot: 1, params: { Nope: 1 } })).error).toBe(true);
    await call("move_effect", { from: 2, to: 1 });
    expect((await call("get_preset")).json.effects[0].type).toBe("Delay");
    await call("remove_effect", { slot: 1 });
    expect((await call("get_preset")).json.effects).toHaveLength(1);
  }, 30_000);

  it("saves, selects and backs up", async () => {
    const saved = await call("save_preset", { preset: 5, name: "MCP Test" });
    expect(saved.json.name).toBe("MCP Test");
    expect((await call("select_preset", { preset: 1 })).json.active_preset).toBe(1);
    expect((await call("select_preset", { preset: 5 })).json.name).toBe("MCP Test");
    const b = await call("backup_preset", { preset: 5, file: "x.preset" });
    expect(b.json.name).toBe("MCP Test");
    const refuse = await call("restore_preset", { file: "x.preset", preset: 6, confirm: false });
    expect(refuse.error).toBe(true);
    const r = await call("restore_preset", { file: "x.preset", preset: 6, confirm: true });
    expect(r.json.verified).toBe(true);
  }, 30_000);

  it("creates presets from specs", async () => {
    const c = await call("create_preset", { name: "Built", effects: [{ type: "Pre-Amp", model: 4 }, { type: "Reverb", model: 1, params: { Decay: 70 } }], slot: 7, confirm: true });
    expect(c.error).toBe(false);
    expect((await call("get_preset", { preset: 7 })).json.effects).toHaveLength(2);
    expect((await call("create_preset", { name: "x", effects: [], slot: 7 })).error).toBe(true);
  }, 30_000);

  it("settings tools convert units", async () => {
    const m = (await call("set_mixer", { master: { mode: "stereo" }, channels: [{ channel: "vocal", level_db: -6, pan: -20, on: false }] })).json;
    expect(m.vocal).toMatchObject({ on: false, level_db: -6, pan: "L20" });
    expect((await call("set_global", { input_gain_db: -7 })).json.input_gain_db).toBe(-5);
    expect((await call("set_tuner", { reference_hz: 442, mute: true })).json).toEqual({ reference_hz: 442, mute: true });
    expect((await call("set_drum", { tempo_bpm: 133, pattern: 3 })).json).toMatchObject({ tempo_bpm: 133, pattern: 3 });
    expect((await call("set_vocal_fx", { eq: { on: true, low_db: -3 } })).json.eq).toMatchObject({ on: true, low_db: -3 });
    expect((await call("set_display", { brightness: 30, rgb: { color: 4 } })).json.brightness).toBe(30);
    expect((await call("set_mixer", {})).error).toBe(true);
  }, 30_000);

  it("guards destructive actions", async () => {
    expect((await call("factory_reset", { confirm: "yes" })).error).toBe(true);
    expect((await call("looper_control", { action: "clear" })).error).toBe(true);
    expect((await call("looper_control", { action: "record" })).error).toBe(false);
  });

  it("catalog lookup", async () => {
    expect((await call("list_effect_catalog", { type: "Delay" })).json.models.length).toBeGreaterThan(3);
    expect((await call("list_effect_catalog", { type: "Drive", model: "808" })).json.params[0].label).toBe("Gain");
  });

  it("samples and bluetooth name", async () => {
    const l = await call("list_samples", { kind: "cab" });
    expect(l.error).toBe(false);
    expect(l.json.cab).toHaveLength(10);
    expect((await call("import_sample", { kind: "cab", slot: 1, file: "x.gir", confirm: false })).error).toBe(true);
    expect((await call("delete_sample", { kind: "drive", slot: 1, confirm: false })).error).toBe(true);
    const bt = await call("set_bluetooth_name", { name: "M2 Luca" });
    expect(bt.json.after).toBe("M2 Luca");
    expect((await call("set_bluetooth_name", { name: "M2 \u00e9" })).error).toBe(true);
  }, 30_000);
});
