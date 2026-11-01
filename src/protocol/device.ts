// Prime M2 protocol session over either link (port of the upstream PrimeM2Device).
//
// - Every command is an `aa 55` frame; the M2 answers the same command set over
//   USB HID and BLE. USB is preferred whenever the pedal is connected.
// - A reply's opcode is the request's + 1. Exactly one request is in flight.
// - Unsolicited frames: 0x15 (preset changed on the pedal), 0x34 (tempo),
//   0x9e (USB heartbeat).
// - Never send 0x81 to an M2: upstream saw it zero a preset's stored values.

import * as frame from "./frame";
import { LOOP_FILE_TYPE, LOOP_FRAME_BYTES, fileFrameRequest, fileFrameWrite, parseFileFrame, splitLoopFile } from "./loopFile";
import { BACKUP_READ, CloudPreset, RECOVERY_WRITE } from "./cloudPreset";
import * as catalog from "./catalog";
import {
  NAME_LENGTH, type MidiAssignment, type PrimeModule, type PrimePreset, decodeName, encodeName, encodeModule, parseModule, parseLooperFiles, parseMidiTable, parseNameList, parseSampleList, type SampleSlot, parsePreset, slotLabel, type LooperFile,
} from "./models";

export type LinkKind = "USB" | "Bluetooth";

export interface Transport {
  kind: LinkKind;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

interface Request {
  payload: Uint8Array;
  /** Queued requests with the same key replace each other (slider drags). */
  key?: string;
  handler: (payload: Uint8Array) => void;
  /** Called instead of `handler` when the request times out or the link goes away. */
  fail?: (reason: string) => void;
  retried: boolean;
  /** The pedal may not answer this command: a short wait, and no connection warning on timeout. */
  optionalReply?: boolean;
  /** Overrides the default wait for the reply. */
  timeoutMs?: number;
}

const RETRYABLE_READS = new Set([0x01, 0x11, 0x21, 0x23, 0x29, 0x33, 0x63, 0x91, 0xa9]);
const replyOf = (r: Request) => (r.payload[0] + 1) & 0xff;
const isBackground = (r: Request) => r.key === "state" || r.key === "battery";

export class PrimeM2Device extends EventTarget {
  isReady = false;
  isBusy = false;
  link: LinkKind | null = null;
  firmware?: string;
  serial?: string;
  battery?: number;
  tempo?: number;
  /** MIDI assignments, from `b1`; empty until read. */
  midiTable: MidiAssignment[] = [];
  sampleSlots = new Map<number, SampleSlot[]>();
  /** Whether the drum machine was started from here; the pedal's own state is not read. */
  drumPlaying = false;
  presetNames = new Map<number, string>();
  /** Drum pattern names (category 7 of the named-list command), in pattern order. */
  drumNames: string[] = [];
  /** Looper file slots, from `53 01 0a`; empty until read. */
  looperFiles: LooperFile[] = [];
  activePresetIndex?: number;
  /** Preset the user just picked, until the pedal confirms it. */
  requestedPresetIndex?: number;
  notice?: string;
  /** Set when the pedal stops answering or a write fails; cleared by the next reply. */
  connectionIssue?: string;
  preset?: PrimePreset;
  presetCache = new Map<number, PrimePreset>();

  private transports = new Map<LinkKind, Transport>();
  private systemState?: Uint8Array;
  /** First system state read in this session, so experimental edits can be undone. */
  originalSystemState?: Uint8Array;
  private rx = new frame.FrameReassembler();
  private queue: Request[] = [];
  private inFlight?: Request;
  private timeout?: ReturnType<typeof setTimeout>;
  private quietUntil?: number;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private scanQueue: number[] = [];
  private editId = 0;
  /** True during a whole-preset transfer: no background scan or polling in between its frames. */
  isTransferring = false;

  constructor(private log: (msg: string) => void = console.log) {
    super();
  }

  get displayedPresetIndex(): number | undefined {
    return this.requestedPresetIndex ?? this.activePresetIndex;
  }

  get scanRemaining(): number {
    return this.scanQueue.length;
  }

  private changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  // ---- Links ---------------------------------------------------------------

  attach(transport: Transport): void {
    this.transports.set(transport.kind, transport);
    this.chooseLink();
  }

  detach(kind: LinkKind): void {
    this.transports.delete(kind);
    this.chooseLink();
  }

  private chooseLink(): void {
    const preferred: LinkKind | null = this.transports.has("USB") ? "USB" : this.transports.has("Bluetooth") ? "Bluetooth" : null;
    if (preferred === this.link) return;
    this.link = preferred;
    if (preferred) {
      this.log(`Prime M2 session over ${preferred}`);
      this.sessionDidStart();
    } else {
      this.reset();
    }
    this.changed();
  }

  /** Raw bytes from the active link (HID report or BLE notification). */
  receive(kind: LinkKind, data: Uint8Array): void {
    if (kind !== this.link) return;
    for (const raw of this.rx.feed(data)) {
      const decoded = frame.decode(raw);
      if (!decoded || !decoded.crcOk || decoded.payload.length === 0) {
        this.log(`Dropped frame with bad CRC: ${frame.hex(raw)}`);
        continue;
      }
      this.handle(decoded.payload);
    }
  }

  // ---- Session lifecycle ---------------------------------------------------

  private sessionDidStart(): void {
    this.reset();
    this.log("Prime M2 session starting");

    this.send(Uint8Array.of(0x01), (p) => {
      this.firmware = p.length > 3 ? decodeName(p.subarray(3)) : undefined;
    });
    this.requestPresetNames(1, 40);
    this.requestPresetNames(41, 80);
    this.requestDrumNames(1, 40);
    this.requestDrumNames(41, 60);
    this.send(Uint8Array.of(0xa9), (p) => {
      this.serial = p.length > 3 ? decodeName(p.subarray(3)) : undefined;
    });
    this.send(Uint8Array.of(0x11), (p) => {
      this.applySystemState(p);
      this.isReady = true;
      const active = this.activePresetIndex ? slotLabel(this.activePresetIndex) : "?";
      this.log(`Synced over ${this.link}: firmware ${this.firmware ?? "?"}, ${this.presetNames.size} preset names, active ${active}, tempo ${this.tempo ?? 0}`);
      if (this.activePresetIndex !== undefined) this.loadPreset(this.activePresetIndex);
      this.scanQueue = Array.from({ length: 80 }, (_, i) => i + 1);
    });
    this.pollBattery();
    this.timers.push(setInterval(() => this.pollBattery(), 30_000));
    // USB doesn't push preset/tempo changes, so poll.
    if (this.link === "USB") this.timers.push(setInterval(() => this.pollState(), 1000));
  }

  private reset(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.timeout);
    clearTimeout(this.quietTimer);
    this.timeout = this.quietTimer = undefined;
    const pending = [...(this.inFlight ? [this.inFlight] : []), ...this.queue];
    this.queue = [];
    this.inFlight = undefined;
    pending.forEach((r) => r.fail?.("Pedal disconnected"));
    this.isTransferring = false;
    this.quietUntil = undefined;
    this.requestedPresetIndex = undefined;
    this.rx.clear();
    this.scanQueue = [];
    this.presetCache = new Map();
    this.systemState = undefined;
    this.originalSystemState = undefined;
    this.isReady = false;
    this.isBusy = false;
    this.connectionIssue = undefined;
    this.firmware = this.serial = this.battery = this.tempo = undefined;
    this.presetNames = new Map();
    this.drumNames = [];
    this.looperFiles = [];
    this.midiTable = [];
    this.sampleSlots = new Map();
    this.activePresetIndex = undefined;
    this.preset = undefined;
  }

  // ---- Commands ------------------------------------------------------------

  /** `53 begin end` -> `54`: the looper file list (the app asks for 1...10). */
  readLooperFiles(): void {
    this.send(Uint8Array.of(0x53, 1, 10), (p) => {
      const files = parseLooperFiles(p);
      this.log(`Looper files (${p.length} bytes): ${frame.hex(p.subarray(0, 60))}${p.length > 60 ? " …" : ""}`);
      if (files) {
        this.looperFiles = files;
        this.changed();
      } else {
        this.log("Looper files: unexpected reply layout");
      }
    });
  }

  /** `b1` -> `b2`: the MIDI mapping table. Only logged: the entry layout is not decoded yet. */
  /** `b3 function` (1-based: the table order starts at 0, the command at 1): the pedal listens for a MIDI message and answers `b4 status ...` (status 1 = learned,
   *  6 = already used by another function). Waits up to 20 s; rejects when nothing arrives. */
  midiLearn(index: number): Promise<{ status: number; bytes: number[] }> {
    this.log(`MIDI learn: function ${index}`);
    return new Promise((resolve, reject) =>
      this.send(
        Uint8Array.of(0xb3, index + 1),
        (p) => {
          this.log(`MIDI learn reply: ${frame.hex(p)}`);
          resolve({ status: p[1] ?? 0, bytes: Array.from(p.subarray(2)) });
        },
        undefined,
        (reason) => reject(new Error(reason)),
        true,
        20000,
      ),
    );
  }

  /** `b5 function`: removes the MIDI assignment of a function, then re-reads the table. */
  midiRemove(index: number): void {
    this.log(`MIDI remove: function ${index}`);
    this.send(Uint8Array.of(0xb5, index + 1), (p) => this.log(`MIDI remove reply: ${frame.hex(p)}`), undefined, undefined, true);
    this.readMidiTable();
  }

  /** `b7`: stores the learned assignments, then re-reads the table. */
  midiSave(): void {
    this.log("MIDI save");
    this.send(Uint8Array.of(0xb7), (p) => this.log(`MIDI save reply: ${frame.hex(p)}`), undefined, undefined, true);
    this.readMidiTable();
  }

  readMidiTable(): void {
    this.send(Uint8Array.of(0xb1), (p) => {
      this.log(`MIDI table (${p.length} bytes): ${frame.hex(p)}`);
      const table = parseMidiTable(p);
      if (table) this.midiTable = table;
    });
  }

  /** `a1`: restores the factory settings and presets (the app sends it with no payload). The pedal needs a
   *  few seconds to rewrite its memory, so the session is restarted afterwards. */
  factoryReset(): void {
    this.log("Factory reset");
    this.send(Uint8Array.of(0xa1), (p) => this.log(`Factory reset reply: ${frame.hex(p)}`), undefined, undefined, true, 3000);
    setTimeout(() => {
      if (this.link) this.sessionDidStart();
    }, 8000);
  }

  /** `4d action`: looper button, 1 Rec, 2 Pause, 3 Undo, 4 Clear, 5 Play. */
  looperAction(action: number): void {
    this.log(`Looper action ${action}`);
    this.send(Uint8Array.of(0x4d, action), (p) => this.log(`Looper reply: ${frame.hex(p)}`), undefined, undefined, true);
    this.changed();
  }

  /** `47 state 00 00`: starts (1) or stops (0) the drum machine. The pedal may not reply. */
  drumPlay(on: boolean): void {
    this.drumPlaying = on;
    this.log(`Drum ${on ? "play" : "stop"}`);
    this.send(Uint8Array.of(0x47, on ? 1 : 0, 0, 0), (p) => this.log(`Drum reply: ${frame.hex(p)}`), undefined, undefined, true);
    this.changed();
  }

  /** The tempo is the drum speed: bytes [41..42] of the system state (u16 LE, 40...260). */
  setTempo(bpm: number): void {
    const state = this.systemState;
    if (!state || state.length <= 42) return;
    const value = Math.max(40, Math.min(260, Math.round(bpm)));
    this.tempo = value;
    state[41] = value & 0xff;
    state[42] = value >> 8;
    this.writeSystemState(state);
  }

  /** The current 99-byte system state (opcode byte included), or undefined before the first sync. */
  get systemStateBytes(): Uint8Array | undefined {
    return this.systemState?.slice();
  }

  /** Experimental: writes the whole system state (`13`) with one byte changed.
   *  The preset byte [1] and the name [9..28] are refused; use selectPreset for the preset. */
  setSystemByte(index: number, value: number): void {
    const state = this.systemState;
    if (!state || index < 2 || (index >= 9 && index <= 28) || index >= state.length || !Number.isInteger(value) || value < 0 || value > 255) return;
    state[index] = value;
    this.writeSystemState(state);
  }

  /** The Bluetooth name, bytes [9..28] of the system state. */
  get bluetoothName(): string {
    return this.systemState ? decodeName(this.systemState.subarray(9, 29)) : "";
  }

  /** Renames the pedal's Bluetooth name (at most 17 printable ASCII characters in all). It takes effect the next
   *  time Bluetooth restarts: switch the pedal off and on, then scan again. */
  setBluetoothName(name: string): boolean {
    const state = this.systemState;
    if (!state || name.length < 1 || name.length > 17 || !/^[\x20-\x7e]+$/.test(name)) return false;
    state.set(encodeName(name, 20), 9);
    this.log(`Bluetooth name: ${name}`);
    this.writeSystemState(state);
    return true;
  }

  /** Writes the state captured at the start of the session back to the pedal. */
  restoreSystemState(): void {
    const original = this.originalSystemState;
    if (!original) return;
    this.systemState = original.slice();
    this.writeSystemState(this.systemState);
  }

  private writeSystemState(state: Uint8Array): void {
    const request = state.slice();
    request[0] = 0x13;
    this.send(request, (p) => {
      if (p.length <= 1 || p[1] !== 1) this.log(`System state write rejected: ${frame.hex(p)}`);
    }, "state-write");
    this.changed();
  }

  selectPreset(index: number): void {
    const state = this.systemState;
    if (!state || state.length <= 1 || index < 1 || index > 80) {
      this.log(`Preset select ${index} skipped: no system state yet`);
      return;
    }
    this.log(`Selecting preset ${slotLabel(index)}`);
    this.requestedPresetIndex = index;
    const request = state.slice();
    request[0] = 0x13;
    request[1] = index;
    this.send(request, (p) => {
      if (this.requestedPresetIndex === index) this.requestedPresetIndex = undefined;
      if (p.length <= 1 || p[1] !== 1) {
        this.log(`Preset select ${index} rejected: ${frame.hex(p)}`);
        return;
      }
      if (this.systemState) this.systemState[1] = index;
      this.activePresetIndex = index;
      this.loadPreset(index);
    });
    this.changed();
  }

  loadPreset(index: number): void {
    this.send(Uint8Array.of(0x21, index), (p) => {
      const preset = parsePreset(p);
      if (!preset) {
        this.log(`Could not parse preset ${index} (${p.length} bytes)`);
        return;
      }
      this.preset = preset;
      this.cache(preset);
      const chain = preset.modules
        .map((m, i) => (m.type === 0 && m.words.length === 0 ? null : `${i + 1}(slot#${m.slot}):${catalog.typeName(m.type)} ${catalog.modelLabel(m.type, m.words[1] ?? 0)} [${m.words.join(",")}]`))
        .filter(Boolean)
        .join(" → ");
      this.log(`Loaded preset ${slotLabel(index)} “${preset.name}”: ${chain || "empty"}`);
    });
    this.send(Uint8Array.of(0x33, index), (p) => this.applyTempo(p));
  }

  /** Live edit of one slot (`25 slot type n data`). Edit buffer only; call savePreset to persist. */
  updateModule(module: PrimeModule): void {
    this.storeModule(module);
    this.send(
      Uint8Array.of(0x25, ...encodeModule(module)),
      (p) => {
        if (p.length < 2 || p[1] !== 1) this.log(`Module ${module.slot} update rejected: ${frame.hex(p)}`);
      },
      `module-${module.slot}`,
    );
    this.changed();
  }

  private storeModule(module: PrimeModule): void {
    if (!this.preset) return;
    const i = this.preset.modules.findIndex((m) => m.slot === module.slot);
    if (i >= 0) {
      this.preset.modules[i] = module;
      this.presetCache.set(this.preset.index, this.preset);
    }
  }

  /** `2d id op slot type model`: op 1 adds into an empty slot, op 2 changes a used one.
   *  A full DSP still answers ok but changes nothing, so the slot is read back. */
  placeModule(slot: number, type: number, model: number): void {
    const occupied = this.preset?.modules.some((m) => m.slot === slot && m.type !== 0) ?? false;
    const wanted = `${catalog.typeName(type)} ${catalog.modelLabel(type, model)}`;
    this.notice = undefined;
    this.editId = (this.editId + 1) & 0xff;
    this.log(`${occupied ? "Changing" : "Adding"} slot ${slot} → ${wanted}`);

    this.send(Uint8Array.of(0x2d, this.editId, occupied ? 2 : 1, slot, type, model & 0xff), (p) => {
      if (p.length <= 2 || p[2] !== 1) {
        this.notice = `The pedal rejected ${wanted} in slot ${slot}.`;
        this.log(this.notice);
        return;
      }
      this.readSlot(slot, (m) => {
        if (!m || m.type !== type || m.words[1] !== model) {
          this.notice = `The pedal didn't take ${wanted} in slot ${slot}, probably because its DSP is full. Remove or change another effect first.`;
          this.log(this.notice);
        }
      });
    });
    this.changed();
  }

  /** `2d id 3 slot`: later slots move up, so the whole edit buffer is re-read. */
  deleteModule(slot: number): void {
    if (!this.preset) return;
    const index = this.preset.index;
    this.notice = undefined;
    this.editId = (this.editId + 1) & 0xff;
    this.log(`Removing slot ${slot}`);
    this.send(Uint8Array.of(0x2d, this.editId, 3, slot, 0, 0), (p) => {
      if (p.length <= 2 || p[2] !== 1) {
        this.notice = `The pedal refused to remove slot ${slot}.`;
        this.log(this.notice);
        return;
      }
      this.loadPreset(index);
    });
    this.changed();
  }

  /** `2d id 4 from to` (1-based slots): takes the effect out of `from` and puts it at
   *  position `to` of the resulting chain, like a drag.
   *  Op 4 of the same command as add/change/delete. */
  moveModule(from: number, to: number): void {
    if (!this.preset || from === to) return;
    const index = this.preset.index;
    this.notice = undefined;
    this.editId = (this.editId + 1) & 0xff;
    this.log(`Moving slot ${from} → ${to}`);
    this.send(Uint8Array.of(0x2d, this.editId, 4, from, to), (p) => {
      if (p.length <= 2 || p[2] !== 1) {
        this.notice = `The pedal refused to move slot ${from} to ${to}.`;
        this.log(this.notice);
        return;
      }
      this.loadPreset(index);
    });
    this.changed();
  }

  private readSlot(slot: number, done: (m: PrimeModule | null) => void): void {
    this.send(Uint8Array.of(0x23, slot), (p) => {
      const parsed = parseModule(p, 1);
      const module = parsed ? parsed[0] : null;
      if (module) this.storeModule(module);
      done(module);
    });
  }

  /** `2f pp name[20]`: saves the edit buffer into preset `index`, then selects it. */
  savePreset(index: number, name: string): void {
    this.send(Uint8Array.of(0x2f, index, ...encodeName(name)), (p) => {
      if (p.length <= 1 || p[1] !== 1) {
        this.log(`Save to ${index} rejected: ${frame.hex(p)}`);
        return;
      }
      this.presetNames.set(index, name);
      this.selectPreset(index);
    });
  }

  /** `65 07 start(u16) end(u16)`: drum pattern names. The reply layout is parsed tolerantly. */
  private requestDrumNames(start: number, end: number): void {
    this.send(Uint8Array.of(0x65, 7, start & 0xff, start >> 8, end & 0xff, end >> 8), (p) => {
      const list = parseNameList(p);
      this.log(`Drum names ${start}-${end} (${p.length} bytes): ${frame.hex(p.subarray(0, 48))}${p.length > 48 ? " …" : ""}`);
      if (!list) return this.log(`Drum names: unexpected reply (${p.length} bytes): ${frame.hex(p.subarray(0, 24))}`);
      list.names.forEach((name, i) => (this.drumNames[list.start - 1 + i] = name));
      this.changed();
    });
  }

  private requestPresetNames(start: number, end: number): void {
    this.send(Uint8Array.of(0x29, start, end), (p) => {
      // 2a start end name[20] x (end - start + 1)
      if (p.length < 3) return;
      let index = p[1];
      for (let offset = 3; offset + NAME_LENGTH <= p.length; offset += NAME_LENGTH) {
        this.presetNames.set(index++, decodeName(p.subarray(offset, offset + NAME_LENGTH)));
      }
    });
  }

  private cache(preset: PrimePreset): void {
    this.presetCache.set(preset.index, preset);
    this.presetNames.set(preset.index, preset.name);
    this.scanQueue = this.scanQueue.filter((i) => i !== preset.index);
  }

  /** Reads one not-yet-cached preset; called from `pump` when idle. */
  private scanNext(): boolean {
    while (this.scanQueue.length) {
      const index = this.scanQueue.shift()!;
      if (this.presetCache.has(index)) continue;
      this.send(Uint8Array.of(0x21, index), (p) => {
        const preset = parsePreset(p);
        if (preset) {
          this.cache(preset);
          this.changed();
        }
      });
      return true;
    }
    return false;
  }

  private pollState(): void {
    if (!this.isReady || this.isTransferring || this.inFlight || this.queue.length) return;
    this.send(
      Uint8Array.of(0x11),
      (p) => {
        if (p.length <= 42) return;
        const previous = this.activePresetIndex;
        this.applySystemState(p);
        const index = this.activePresetIndex;
        if (index !== undefined && index !== previous) {
          this.log(`Pedal switched to preset ${slotLabel(index)}`);
          this.loadPreset(index);
        }
      },
      "state",
    );
  }

  private pollBattery(): void {
    if (this.isTransferring) return;
    this.send(Uint8Array.of(0x91), (p) => {
      if (p.length > 1) this.battery = p[1];
    }, "battery");
  }

  // ---- Whole-preset transfer (USB only) --------------------------------------

  /** One request/reply exchange as a promise; rejects on timeout or disconnect. */
  private request(payload: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => this.send(payload, resolve, undefined, (reason) => reject(new Error(reason))));
  }

  /** Runs `job` with background reads paused; the transfer commands are USB-only. */
  async transfer<T>(job: () => Promise<T>): Promise<T> {
    if (this.link !== "USB") throw new Error("Preset backup and restore need the USB connection.");
    if (this.isTransferring) throw new Error("Another transfer is running.");
    this.isTransferring = true;
    this.changed();
    try {
      return await job();
    } finally {
      this.isTransferring = false;
      this.changed();
      this.pump();
    }
  }

  /** Reads file `id` (1...10) of file type `type`: its name and bytes. Call inside `transfer`. */
  async readFile(type: number, id: number, onProgress?: (done: number, total: number) => void): Promise<{ name: string; data: Uint8Array }> {
    const head = parseFileFrame(await this.request(fileFrameRequest(id, 0, type)));
    if (!head || head.status === 0 || head.total === 0) throw new Error(`File ${id} is empty or unreadable`);
    const name = new TextDecoder().decode(head.data.subarray(0, head.data.indexOf(0) < 0 ? head.data.length : head.data.indexOf(0)));
    const chunks: Uint8Array[] = [];
    for (let n = 1; n < head.total; n++) {
      const frame = parseFileFrame(await this.request(fileFrameRequest(id, n, type)));
      if (!frame) throw new Error(`Frame ${n}/${head.total - 1} was not delivered`);
      chunks.push(frame.data);
      if (n % 100 === 0 || n === head.total - 1) onProgress?.(n, head.total - 1);
    }
    const data = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      data.set(c, offset);
      offset += c.length;
    }
    return { name, data };
  }

  /** Reads loop file `id` (1...10): its name and audio. Call inside `transfer`; a 30 s loop is about 8000 frames. */
  async readLoopFile(id: number, onProgress?: (done: number, total: number) => void): Promise<{ name: string; control: Uint8Array; audio: Uint8Array }> {
    const { name, data } = await this.readFile(LOOP_FILE_TYPE, id, onProgress);
    return { name, ...splitLoopFile(data) };
  }

  /** Writes file `id` (1...10) of file type `type` in frames of `frameBytes`. Every frame is acknowledged; a rejected
   *  or unanswered frame is retried twice, then the upload stops. Call inside `transfer`. */
  async writeFile(type: number, id: number, name: string, data: Uint8Array, frameBytes: number, onProgress?: (done: number, total: number) => void): Promise<void> {
    const nameBytes = new TextEncoder().encode(name.slice(0, 50));
    const total = Math.ceil(data.length / frameBytes) + 1;
    for (let i = 0; i < total; i++) {
      const chunk = i === 0 ? nameBytes : data.subarray((i - 1) * frameBytes, i * frameBytes);
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
        try {
          const reply = await this.request(fileFrameWrite(id, total, i, chunk, type));
          accepted = !(reply.length > 1 && reply[1] === 0);
        } catch {
          accepted = false;
        }
      }
      if (!accepted) throw new Error(`The pedal rejected frame ${i + 1}/${total}; slot ${id} may be incomplete`);
      if (i % 100 === 0 || i === total - 1) onProgress?.(i + 1, total);
    }
  }

  /** Writes loop file `id` (1...10): `data` is 1000 bytes of control data followed by the audio. Call inside `transfer`. */
  async writeLoopFile(id: number, name: string, data: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<void> {
    await this.writeFile(LOOP_FILE_TYPE, id, name, data, LOOP_FRAME_BYTES, onProgress);
  }

  /** `67 type id 01 name` -> `68`: deletes a sample file. Call inside `transfer`. */
  async deleteFile(type: number, id: number, name: string): Promise<void> {
    const nameBytes = new TextEncoder().encode(name.slice(0, 50));
    const reply = await this.request(Uint8Array.of(0x67, type, id & 0xff, id >> 8, 1, ...nameBytes));
    if (reply[4] !== 1) throw new Error(`The pedal did not delete the file (${frame.hex(reply)})`);
  }

  /** Marks a sample slot as empty without asking the pedal, e.g. right after a delete. */
  clearSampleSlot(type: number, id: number): void {
    const slots = this.sampleSlots.get(type);
    if (slots) this.sampleSlots.set(type, slots.map((s) => (s.id === id ? { ...s, name: "", empty: true, length: 0 } : s)));
    this.changed();
  }

  /** `65 type 1 10` -> `66`: the 10 sample slots of a file type. */
  readSampleList(type: number): void {
    this.send(Uint8Array.of(0x65, type, 1, 0, 10, 0), (p) => {
      const list = parseSampleList(p);
      this.log(`Samples type ${type} (${p.length} bytes): ${frame.hex(p.subarray(0, 64))}${p.length > 64 ? " …" : ""}`);
      if (!list) return this.log(`Samples type ${type}: unexpected reply`);
      this.sampleSlots.set(type, list);
      this.changed();
    });
  }

  /** Reads stored preset `index` (1...80) in the whole-preset format. Call inside `transfer`. */
  async readStoredPreset(index: number): Promise<CloudPreset> {
    const head = await this.request(Uint8Array.of(BACKUP_READ, index, 0, 0));
    if (head.length < 3) throw new Error(`Preset ${slotLabel(index)} is empty or unreadable`);
    const count = head[1] | (head[2] << 8);
    const frames: Uint8Array[] = [];
    for (let n = 1; n <= count; n++) {
      const p = await this.request(Uint8Array.of(BACKUP_READ, index, n & 0xff, n >> 8));
      if (p.length < 5) throw new Error(`Short reply for preset frame ${n}`);
      const len = p[3] | (p[4] << 8);
      if (p.length < 5 + len) throw new Error(`Preset frame ${n} truncated`);
      frames.push(p.slice(5, 5 + len));
    }
    const preset = CloudPreset.fromFrames(frames);
    if (!preset) throw new Error(`Unexpected preset format (${frames.map((f) => f.length).join("+")} bytes)`);
    return preset;
  }

  /** Writes `preset` to `index`: 0 = audition slot (plays it, stores nothing), 1...80 = stored preset. */
  async writeStoredPreset(index: number, preset: CloudPreset): Promise<void> {
    const frames = preset.frames;
    for (let n = 1; n <= frames.length; n++) {
      const data = frames[n - 1];
      const p = await this.request(
        Uint8Array.of(RECOVERY_WRITE, index, n & 0xff, n >> 8, data.length & 0xff, data.length >> 8, ...data),
      );
      if (p.length < 4 || p[3] !== 1) throw new Error(`Pedal rejected preset frame ${n} (${frame.hex(p)})`);
    }
  }

  /** `ad ff 00 00 00 00`: leaves the audition. Call inside `transfer`. */
  async endAudition(): Promise<void> {
    await this.request(Uint8Array.of(RECOVERY_WRITE, 0xff, 0, 0, 0, 0));
  }

  /** Overwrites stored preset `index` and checks it reads back identically. */
  async restoreStoredPreset(index: number, preset: CloudPreset): Promise<void> {
    await this.writeStoredPreset(index, preset);
    const stored = await this.readStoredPreset(index);
    if (!stored.equals(preset)) throw new Error(`Preset ${slotLabel(index)} read back differently after writing`);
    this.presetCache.delete(index);
    this.log(`Preset ${slotLabel(index)} written and verified`);
  }

  /** Re-reads preset `index` through the normal session after a restore, so the editor shows it. */
  refreshPreset(index: number): void {
    if (index === this.activePresetIndex) {
      this.loadPreset(index);
    } else {
      this.scanQueue = [...new Set([...this.scanQueue, index])];
      this.pump();
    }
  }

  // ---- Request queue -------------------------------------------------------

  private send(payload: Uint8Array, handler: (p: Uint8Array) => void, key?: string, fail?: (reason: string) => void, optionalReply = false, timeoutMs?: number): void {
    const request: Request = { payload, key, handler, fail, retried: false, optionalReply, timeoutMs };
    const existing = key === undefined ? -1 : this.queue.findIndex((q) => q.key === key);
    if (existing >= 0) this.queue[existing] = request;
    else this.queue.push(request);
    this.pump();
  }

  private pump(): void {
    if (!this.inFlight && !this.queue.length && this.isReady && !this.isTransferring && this.scanNext()) return;
    const busy = (!!this.inFlight && !isBackground(this.inFlight)) || this.queue.some((r) => !isBackground(r));
    if (busy !== this.isBusy) {
      this.isBusy = busy;
      this.changed();
    }
    const transport = this.link ? this.transports.get(this.link) : undefined;
    if (this.inFlight || !this.queue.length || !transport) return;
    if (this.quietUntil !== undefined) {
      const remaining = this.quietUntil - Date.now();
      if (remaining > 0) {
        if (this.quietTimer === undefined) {
          this.quietTimer = setTimeout(() => {
            this.quietTimer = undefined;
            this.pump();
          }, remaining);
        }
        return;
      }
    }
    const request = this.queue.shift()!;
    this.inFlight = request;
    transport.write(frame.encode(request.payload)).catch((e) => {
      this.log(`Write failed: ${e}`);
      this.connectionIssue = "Writing to the pedal failed. Check the connection.";
      this.changed();
    });
    this.timeout = setTimeout(() => this.onTimeout(), request.timeoutMs ?? (request.optionalReply ? 500 : 2000));
  }

  private onTimeout(): void {
    const stuck = this.inFlight;
    if (!stuck) return;
    this.inFlight = undefined;
    if (RETRYABLE_READS.has(stuck.payload[0]) && !stuck.retried) {
      this.log(`No reply 0x${replyOf(stuck).toString(16)}, retrying`);
      stuck.retried = true;
      this.queue.unshift(stuck);
    } else if (stuck.optionalReply) {
      this.log(`No reply 0x${replyOf(stuck).toString(16)} (the command may not be answered)`);
      stuck.fail?.("No reply");
    } else {
      this.log(`Timeout waiting for reply 0x${replyOf(stuck).toString(16)}`);
      this.connectionIssue = "The pedal stopped answering. Check the cable or reconnect.";
      if (stuck.payload[0] === 0x13) this.requestedPresetIndex = undefined;
      stuck.fail?.(`No reply 0x${replyOf(stuck).toString(16)} from the pedal`);
    }
    this.pump();
    this.changed();
  }

  // ---- Receive path --------------------------------------------------------

  private handle(payload: Uint8Array): void {
    const opcode = payload[0];
    const request = this.inFlight;
    if (request && replyOf(request) === opcode) {
      this.connectionIssue = undefined;
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.inFlight = undefined;
      // Select (14), save (30) and module add/remove (2e) leave the pedal deaf for a moment over USB.
      if (this.link === "USB" && (opcode === 0x14 || opcode === 0x30 || opcode === 0x2e || opcode === 0xae)) this.quietUntil = Date.now() + 300;
      request.handler(payload);
      this.pump();
      this.changed();
      return;
    }
    if (opcode === 0x15) {
      this.applySystemState(payload);
      if (this.activePresetIndex !== undefined) this.loadPreset(this.activePresetIndex);
    } else if (opcode === 0x34) {
      this.applyTempo(payload);
    } else if (opcode === 0x69) {
      // Looper update pushed by the pedal (e.g. a recording finished): refresh the file list if it was read before.
      this.log(`Looper update 0x69: ${frame.hex(payload.subarray(1))}`);
      if (this.looperFiles.length) this.readLooperFiles();
    } else if (opcode !== 0x9e) {
      this.log(`Unsolicited 0x${opcode.toString(16)}: ${frame.hex(payload.subarray(1))}`);
    }
    this.changed();
  }

  private applySystemState(payload: Uint8Array): void {
    if (payload.length <= 42) return;
    const previous = this.systemState;
    this.systemState = payload.slice();
    this.originalSystemState ??= payload.slice();
    if (!previous) {
      this.log(`System state: ${frame.hex(payload)}`);
    } else {
      const diffs = Array.from(payload, (b, i) => (b !== previous[i] ? `[${i}] ${previous[i]}→${b}` : null)).filter(Boolean);
      if (diffs.length) this.log(`System state changed: ${diffs.join(", ")}`);
    }
    this.activePresetIndex = payload[1];
    this.tempo = payload[41] | (payload[42] << 8);
  }

  private applyTempo(payload: Uint8Array): void {
    if (payload.length > 2) this.tempo = payload[1] | (payload[2] << 8);
  }
}
