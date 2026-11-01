import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LOOP_CONTROL_BYTES, LOOP_MAX_BYTES, LOOP_SAMPLE_RATE, buildWav, isPedalFormat, packPcm24, readWav, wavControl } from "../protocol/loopFile";
import { wavSamples } from "../wav";
import { MIDI_FUNCTIONS } from "../protocol/models";
import { session, PedalError } from "../session";
import { readFile, safeName, tool, writeFile } from "./util";

const loopId = z.number().int().min(1).max(10);
const ACTIONS = { record: 1, pause: 2, undo: 3, clear: 4, play: 5 } as const;

/** Converts any 8/16/24/32-bit PCM or 32-bit float WAV to the pedal's 24-bit stereo 44.1 kHz data (linear resampling). */
export function wavToPedal(bytes: Uint8Array): Uint8Array {
  const wav = readWav(bytes);
  if (!wav) throw new PedalError("Not a WAV file.");
  if (wav.audioFormat === 1 && wav.bits === 24 && isPedalFormat(wav)) {
    const data = new Uint8Array(LOOP_CONTROL_BYTES + wav.dataSize);
    data.set(wavControl(bytes, wav), 0);
    data.set(bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize), LOOP_CONTROL_BYTES);
    return data;
  }
  const { frames, sample } = wavSamples(bytes, wav);
  const outLen = Math.floor((frames * LOOP_SAMPLE_RATE) / wav.sampleRate);
  const left = new Float32Array(outLen);
  const right = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * wav.sampleRate) / LOOP_SAMPLE_RATE;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, frames - 1);
    const t = pos - a;
    left[i] = sample(a, 0) * (1 - t) + sample(b, 0) * t;
    right[i] = sample(a, 1) * (1 - t) + sample(b, 1) * t;
  }
  const pcm = packPcm24(left, right);
  const data = new Uint8Array(LOOP_CONTROL_BYTES + pcm.length);
  data.set(pcm, LOOP_CONTROL_BYTES);
  return data;
}

export function registerLooperTools(server: McpServer) {
  tool(server, "looper_control", "Looper buttons: record (keeps overdubbing until play), play, pause, undo (last rec session, in play mode), clear (deletes the loop). The pedal sends no confirmation.", {
    action: z.enum(["record", "play", "pause", "undo", "clear"]),
    confirm: z.boolean().optional().describe("Required for clear"),
  }, {}, async ({ action, confirm }, d) => {
    if (action === "clear" && !confirm) throw new PedalError("clear deletes the recording; call again with confirm: true.");
    d.looperAction(ACTIONS[action]);
    await session.settle();
    return { sent: action };
  });

  tool(server, "set_looper", "Looper song (1-10) and volume (0-100).", {
    song: loopId.optional(),
    volume: z.number().int().min(0).max(100).optional(),
  }, { idempotent: true }, async ({ song, volume }, d) => {
    if (song === undefined && volume === undefined) throw new PedalError("Nothing to change.");
    if (song !== undefined) d.setSystemByte(48, song);
    if (volume !== undefined) d.setSystemByte(47, volume);
    await session.settle();
    const s = d.systemStateBytes!;
    return { song: s[48], volume: s[47] };
  });

  tool(server, "list_loops", "The 10 loop slots: empty/recorded, name, duration, sync.", {}, { readOnly: true }, async (_a, d) => {
    d.looperFiles = [];
    d.readLooperFiles();
    await session.waitFor(() => d.looperFiles.length > 0, 5000, "the loop list");
    return d.looperFiles.map((f, i) => ({ loop: i + 1, empty: f.empty, name: f.name || undefined, seconds: f.empty ? undefined : Math.round(f.ms / 100) / 10, sync: f.sync || undefined }));
  });

  tool(server, "export_loop", "Save a loop to a 24-bit stereo 44.1 kHz WAV file (USB; a 30 s loop takes a while). The pedal's control data rides after the audio so import_loop can restore it exactly.", {
    loop: loopId,
    file: z.string().optional(),
  }, { readOnly: true }, async ({ loop, file }, d) => {
    const f = await d.transfer(() => d.readLoopFile(loop));
    const path = writeFile(file ?? `loops/loop-${loop}-${safeName(f.name || "loop")}.wav`, buildWav(f.audio, f.control));
    return { file: path, name: f.name, seconds: Math.round(f.audio.length / 6 / LOOP_SAMPLE_RATE * 10) / 10 };
  });

  tool(server, "import_loop", "Upload a WAV into a loop slot (USB), replacing its content. WAVs of any common PCM format are converted to 24-bit stereo 44.1 kHz. A non-empty slot is first exported to the backups folder.", {
    loop: loopId,
    file: z.string(),
    name: z.string().max(20).optional(),
    confirm: z.boolean().describe("Must be true"),
  }, { destructive: true }, async ({ loop, file, name, confirm }, d) => {
    if (!confirm) throw new PedalError("confirm must be true: this replaces the loop in that slot.");
    const bytes = readFile(file);
    const data = wavToPedal(bytes);
    if (data.length > LOOP_MAX_BYTES) throw new PedalError("The loop is too long for the pedal.");
    d.looperFiles = [];
    d.readLooperFiles();
    await session.waitFor(() => d.looperFiles.length > 0, 5000, "the loop list");
    let backup: string | undefined;
    if (!d.looperFiles[loop - 1]?.empty) {
      const old = await d.transfer(() => d.readLoopFile(loop));
      backup = writeFile(`backups/before-import-loop-${loop}-${safeName(old.name || "loop")}.wav`, buildWav(old.audio, old.control));
    }
    const loopName = (name ?? file.split("/").pop()!.replace(/\.wav$/i, "")).replace(/[^\x20-\x7e]+/g, "_").slice(0, 20);
    await d.transfer(() => d.writeLoopFile(loop, loopName, data));
    d.readLooperFiles();
    await session.settle();
    return { imported: loopName, loop, seconds: Math.round((data.length - LOOP_CONTROL_BYTES) / 6 / LOOP_SAMPLE_RATE * 10) / 10, backup };
  });

  tool(server, "midi_assignments", "The 20 MIDI-controllable functions and the CC/value assigned to each.", {}, { readOnly: true }, async (_a, d) => {
    d.midiTable = [];
    d.readMidiTable();
    await session.waitFor(() => d.midiTable.length > 0, 5000, "the MIDI table");
    return MIDI_FUNCTIONS.map((fn, i) => ({ function: i + 1, name: fn, assigned: d.midiTable[i].assigned, value: d.midiTable[i].assigned ? d.midiTable[i].value : undefined }));
  });

  tool(server, "midi_edit", "Edit MIDI assignments. learn: the pedal listens up to 20 s for an incoming MIDI message for function N (verified over Bluetooth only; USB may not answer). remove: clear function N. save: store learned assignments. Seen on hardware: remove(6) then save also cleared function 1; check midi_assignments afterwards.", {
    action: z.enum(["learn", "remove", "save"]),
    function: z.number().int().min(1).max(20).optional().describe("1-based, as in midi_assignments"),
  }, { destructive: true }, async ({ action, function: fn }, d) => {
    if (action !== "save" && fn === undefined) throw new PedalError("function is required for learn/remove.");
    if (action === "learn") {
      try {
        const r = await d.midiLearn(fn! - 1);
        return { status: r.status === 1 ? "learned" : r.status === 6 || r.status === 3 ? "already used by another function" : `status ${r.status}`, bytes: r.bytes };
      } catch (e) {
        throw new PedalError(`No MIDI message learned: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (action === "remove") d.midiRemove(fn! - 1);
    else d.midiSave();
    await session.settle();
    return { done: action };
  });
}
