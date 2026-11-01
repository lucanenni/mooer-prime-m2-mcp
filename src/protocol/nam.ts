// Neural Amp Modeler captures for the Pre-Amp and Entire Amp slots. Only the newer "A2" captures (a slimmable
// container) can be sent: the pedal takes the weights of the small 3-channel model as 2560 float32 values with a
// marker in the last four bytes. Older captures need a converter that runs natively and are not supported here.

export const NAM_A2_NAME_MARKER = "__N|A2__";
const FLOAT_COUNT = 2560;
const END_MARKER = [0xff, 0xaa, 0xbb, 0xcc];

interface NamFile {
  architecture?: unknown;
  config?: { submodels?: { model?: { config?: { layers?: { channels?: number }[] }; weights?: unknown } }[] };
}

/** The payload of an A2 capture, or an error message explaining why the file cannot be sent. */
export function namA2Payload(text: string): { data: Uint8Array } | { error: string } {
  let nam: NamFile;
  try {
    nam = JSON.parse(text) as NamFile;
  } catch {
    return { error: "This is not a valid .nam file." };
  }
  if (nam.architecture !== "SlimmableContainer") {
    return { error: "Only the newer A2 (slimmable) NAM captures are supported; older ones need a converter that runs natively." };
  }
  const lite = (nam.config?.submodels ?? []).find((s) => s.model?.config?.layers?.[0]?.channels === 3);
  const weights = lite?.model?.weights;
  if (!Array.isArray(weights)) return { error: "The small 3-channel model of this capture was not found." };
  const floats = new Float32Array(FLOAT_COUNT);
  for (let i = 0; i < Math.min(weights.length, FLOAT_COUNT); i++) {
    const v = Number(weights[i]);
    floats[i] = Number.isFinite(v) ? v : 0;
  }
  const data = new Uint8Array(floats.buffer);
  data.set(END_MARKER, data.length - END_MARKER.length);
  return { data };
}

export const stripNamMarker = (name: string) => name.split(NAM_A2_NAME_MARKER).join("").trim();
