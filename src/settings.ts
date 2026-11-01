// System-state byte map (docs/PROTOCOL.md §4 of the web editor) as named, human-unit settings.

export const MIXER_MAX = 72;
export const INPUT_GAIN_DB: (number | "off")[] = ["off", -60, -45, -35, -30, -25, -20, -10, -5, 0, ...Array.from({ length: 12 }, (_, i) => (i + 1) / 2)];
export const SLEEP_MINUTES = [5, 10, 15, 20, 30];
export const RGB_COLORS = ["#ff6400", "#ffdc00", "#64ff00", "#ff0000", "#00ffff", "#ffffff", "#0064ff", "#c800ff", "#ff00f3"];

export const levelToDb = (raw: number) => raw / 2 - 30;
export const dbToLevel = (db: number) => clamp(Math.round((db + 30) * 2), 0, MIXER_MAX);
export const eqToDb = (raw: number) => raw / 2 - 12;
export const dbToEq = (db: number) => clamp(Math.round((db + 12) * 2), 0, 48);
export const panName = (raw: number) => (raw === 50 ? "C" : raw < 50 ? `L${50 - raw}` : `R${raw - 50}`);

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Pairs of [byte index, value] to write into the system state. */
export type ByteWrites = [number, number][];

export const CHANNELS = {
  instrument: { off: 33, level: 34, pan: 92 },
  vocal: { off: 51, level: 52, pan: 89 },
  bluetooth: { off: 29, level: 30, pan: 90 },
  usb: { off: 31, level: 32, pan: 91 },
} as const;
export type ChannelName = keyof typeof CHANNELS;

export function decodeSettings(s: Uint8Array) {
  const channel = (c: (typeof CHANNELS)[ChannelName]) => ({
    on: s[c.off] === 0,
    level_db: levelToDb(Math.min(s[c.level], MIXER_MAX)),
    pan: panName(Math.min(s[c.pan], 100)),
    pan_raw: Math.min(s[c.pan], 100),
  });
  const gain = INPUT_GAIN_DB[s[7]];
  return {
    active_preset: s[1],
    pedal_name: new TextDecoder().decode(s.subarray(9, 29)).replace(/\0.*$/, ""),
    mixer: {
      instrument: channel(CHANNELS.instrument),
      vocal: channel(CHANNELS.vocal),
      bluetooth: channel(CHANNELS.bluetooth),
      usb: channel(CHANNELS.usb),
      master: {
        mode: s[39] === 1 ? "stereo" : "mono",
        mute: s[35] === 1,
        link_lr: s[36] === 1,
        left_db: levelToDb(s[37]),
        right_db: levelToDb(s[38]),
        three_d: s[88] === 1,
      },
    },
    vocal_fx: {
      comp: { on: s[53] === 1, level: s[55], sensitivity: s[57] },
      eq: { on: s[59] === 1, low_db: eqToDb(s[61]), mid_db: eqToDb(s[63]), high_db: eqToDb(s[65]) },
      reverb: { on: s[67] === 1, mix: s[69], decay: s[71], time: s[73] },
    },
    global: {
      cabsim: s[2] === 1,
      input_gain_db: gain === undefined ? `raw ${s[7]}` : gain,
      eq: { on: s[49] === 1, hz100_db: eqToDb(s[3]), hz350_db: eqToDb(s[4]), hz1800_db: eqToDb(s[5]), hz4000_db: eqToDb(s[6]) },
      tempo_sync: s[98] === 1 ? "global" : "preset",
    },
    tuner: { reference_hz: 430 + s[44], mute: s[45] === 1 },
    drum: { pattern: s[43] + 1, tempo_bpm: s[41] | (s[42] << 8), sync_with_looper: s[46] === 1 },
    looper: { song: s[48], volume: s[47] },
    display: {
      brightness: s[75],
      auto_shutdown: s[8] === 255 ? "never" : `${s[8]} min`,
      footswitch_page: s[76] === 1,
      rgb: {
        dynamic: s[94] === 1,
        brightness: s[96] === 1 ? "bright" : "soft",
        color: s[97],
        color_hex: RGB_COLORS[s[97] - 1],
        speed: ["I", "II", "III"][s[95]] ?? s[95],
        sequence: Array.from({ length: 9 }, (_, i) => s[77 + i]),
      },
    },
  };
}

const b = (on: boolean) => (on ? 1 : 0);

export interface MixerChange {
  channel?: ChannelName;
  on?: boolean;
  level_db?: number;
  pan?: number;
}

/** Channel edits. `pan`: -50 (left) ... 0 (centre) ... +50 (right). */
export function channelWrites(c: MixerChange): ByteWrites {
  if (!c.channel) return [];
  const ch = CHANNELS[c.channel];
  const w: ByteWrites = [];
  if (c.on !== undefined) w.push([ch.off, b(!c.on)]);
  if (c.level_db !== undefined) w.push([ch.level, dbToLevel(c.level_db)]);
  if (c.pan !== undefined) w.push([ch.pan, clamp(Math.round(c.pan) + 50, 0, 100)]);
  return w;
}

export interface MasterChange {
  mode?: "mono" | "stereo";
  mute?: boolean;
  link_lr?: boolean;
  level_db?: number;
  left_db?: number;
  right_db?: number;
  three_d?: boolean;
}

export function masterWrites(m: MasterChange, s: Uint8Array): ByteWrites {
  const w: ByteWrites = [];
  if (m.mode) w.push([39, m.mode === "stereo" ? 1 : 0]);
  if (m.mute !== undefined) w.push([35, b(m.mute)]);
  if (m.link_lr !== undefined) w.push([36, b(m.link_lr)]);
  if (m.three_d !== undefined) w.push([88, b(m.three_d)]);
  const stereo = (m.mode ?? (s[39] === 1 ? "stereo" : "mono")) === "stereo";
  const linked = m.link_lr ?? s[36] === 1;
  let left = m.left_db;
  let right = m.right_db;
  if (m.level_db !== undefined) left = right = m.level_db; // one slider drives both
  if (!stereo) right = left ?? right;
  if (stereo && linked) {
    if (left !== undefined && right === undefined) right = left;
    if (right !== undefined && left === undefined) left = right;
  }
  if (left !== undefined) w.push([37, dbToLevel(left)]);
  if (right !== undefined) w.push([38, dbToLevel(right)]);
  if (m.mode === "mono" && left === undefined) w.push([38, s[37]]);
  return w;
}

export function inputGainStep(v: number | "off"): number {
  if (v === "off") return 0;
  let best = 1;
  for (let i = 1; i < INPUT_GAIN_DB.length; i++) if (Math.abs((INPUT_GAIN_DB[i] as number) - v) < Math.abs((INPUT_GAIN_DB[best] as number) - v)) best = i;
  return best;
}
