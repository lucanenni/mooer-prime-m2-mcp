# Mooer Prime M2 MCP

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant control a **Mooer Prime M2** multi-effects pedal over USB. It offers the same functions as the companion browser editor, [mooer-prime-m2-web](https://github.com/lucanenni/mooer-prime-m2-web), as tools you can ask for in plain language: "put a 808 and a plate reverb after the amp in preset 12", "back up all my presets", "set the tuner to 442 Hz".

> Unofficial. Not affiliated with or endorsed by Mooer Audio. Use at your own risk, and read [Safety](#safety) first.

## What it can do

- **Presets**: list the 80 presets (optionally with their chains), read any preset with every parameter in real units, select, save, rename, copy, and build a whole preset from a list of effects in one step.
- **Effects**: browse the catalog (all types and models, with each model's parameters), add, change, remove, reorder, switch on/off and edit parameters by name in dB, Hz, ms or semitones. Delay time and mod rate also take tempo-sync notes such as `"1/8D"`.
- **Mixer and settings**: channel levels, pan and switches, master section, Vocal FX, global CabSim/EQ/input gain, tuner, drum machine (pattern, tempo, play/stop), display, auto shutdown, footswitch, RGB light, Bluetooth name.
- **Looper**: record/play/pause/undo/clear, song and volume, loop list, export loops to WAV and import WAV files.
- **Samples** (experimental): list, export, import and delete cab IRs, drive, pre-amp and entire-amp files, including newer NAM A2 captures.
- **Backup and restore**: export one preset or all 80, restore from `.preset` or bank files with read-back verification, audition a preset without storing it.
- **MIDI**: read and edit the function assignments.
- **Advanced**: raw system state, single-byte writes, restore of the session's initial state, factory reset.

## Requirements

- Node.js 20 or later.
- A Mooer Prime M2 connected by **USB**. Close Mooer Studio and the web editor first: only one program can talk to the pedal at a time. Bluetooth is not supported.
- macOS, Linux or Windows (USB access goes through [`node-hid`](https://github.com/node-hid/node-hid), which ships prebuilt binaries).

## Install

```bash
git clone https://github.com/lucanenni/mooer-prime-m2-mcp.git
cd mooer-prime-m2-mcp
npm install
npm run build
```

Register it with your MCP client.

Claude Code:

```bash
claude mcp add mooer-prime-m2 -- node /absolute/path/to/mooer-prime-m2-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mooer-prime-m2": {
      "command": "node",
      "args": ["/absolute/path/to/mooer-prime-m2-mcp/dist/index.js"]
    }
  }
}
```

The server connects to the pedal on the first tool call and reconnects after you replug the cable.

| Variable | Meaning |
|---|---|
| `MOOER_DATA_DIR` | Folder for backups, exports and relative file paths (default `~/mooer-prime-m2`) |
| `MOOER_DEMO=1` | Use a simulated pedal instead of hardware (`npm run demo`) |

## Tools

| Area | Tools |
|---|---|
| Status | `get_status`, `get_settings`, `get_system_state` |
| Presets | `list_presets`, `get_preset`, `select_preset`, `save_preset`, `copy_preset`, `create_preset` |
| Effects (edit buffer) | `list_effect_catalog`, `add_effect`, `change_effect`, `remove_effect`, `move_effect`, `edit_effect` |
| Mixer and settings | `set_mixer`, `set_vocal_fx`, `set_global`, `set_tuner`, `set_drum`, `list_drum_patterns`, `set_display`, `set_bluetooth_name` |
| Looper | `looper_control`, `set_looper`, `list_loops`, `export_loop`, `import_loop` |
| Samples | `list_samples`, `export_sample`, `import_sample`, `delete_sample` |
| Backup | `backup_preset`, `backup_all_presets`, `restore_preset`, `audition_preset`, `end_audition` |
| MIDI | `midi_assignments`, `midi_edit` |
| Advanced | `set_system_byte`, `restore_system_state`, `factory_reset` |

Effects are addressed by type and model name (`"Drive"`, `"808"`) or id. Chain positions are 1-based; presets are 1-80 (`0A` is preset 1, `19D` is preset 80).

## Safety

- Effect edits live in the pedal's edit buffer until `save_preset`; selecting another preset discards them.
- Mixer, tuner, drum and other global settings are written to the pedal immediately. `restore_system_state` writes back the values read when the session started.
- Every tool that replaces stored data (`save_preset`, `copy_preset`, `restore_preset`, `create_preset` with a slot, `import_loop`, `import_sample`, `delete_sample`) first saves the old content under `<data dir>/backups/`. Whole-preset writes are read back and verified. They need `confirm: true`; `factory_reset` needs `confirm: "ERASE ALL"`.
- What is verified on a real pedal, and what is not, follows the web editor's [TESTING.md](https://github.com/lucanenni/mooer-prime-m2-web/blob/main/TESTING.md). Samples, the Bluetooth name and MIDI learn over USB are unverified or experimental. Older (non-A2) NAM captures are not supported.

## Development

```bash
npm run dev      # run from source over stdio
npm run demo     # same, against the simulated pedal
npm test         # end-to-end tests of every tool area against the simulated pedal
npm run build    # type-check and bundle to dist/
npm run sync     # refresh src/protocol and src/demo from ../mooer-prime-m2-web
```

`src/protocol` and `src/demo` are copied unchanged from the web editor, which is the single source of truth for the protocol; see its `docs/PROTOCOL.md`. The tools live in `src/tools`, the unit conversions in `src/settings.ts` and `src/effects.ts`.

## Credits and license

The protocol layer is inspired by, and partly derived from, [andymann/mooer-prime-m2-app](https://github.com/andymann/mooer-prime-m2-app) (MIT), through the web editor. The original copyright notice is kept in [LICENSE](LICENSE).

Released under the [MIT license](LICENSE).
