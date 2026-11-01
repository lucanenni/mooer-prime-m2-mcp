// USB HID link via node-hid. VID 0x34DB, PID 13; 1024-byte reports, no report ID.

import HID from "node-hid";
import type { PrimeM2Device, Transport } from "../protocol/device";

export const VENDOR_ID = 0x34db;
export const PRODUCT_ID = 13;
const REPORT_SIZE = 1024;

export const findPedal = () => HID.devices().find((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);

/** Output report = [reportId 0, frameLength, frame...], zero-padded to the report size. */
export function hidReport(frame: Uint8Array): number[] {
  const out = new Array<number>(REPORT_SIZE + 1).fill(0);
  out[1] = frame.length;
  out.splice(2, frame.length, ...frame);
  return out.slice(0, REPORT_SIZE + 1);
}

export class NodeHidLink implements Transport {
  kind = "USB" as const;
  closed = false;

  private constructor(private hid: HID.HID, private device: PrimeM2Device, private onLost: (reason: string) => void) {}

  static connect(device: PrimeM2Device, onLost: (reason: string) => void): NodeHidLink {
    const info = findPedal();
    if (!info?.path) throw new Error("Mooer Prime M2 not found on USB. Plug it in and close other programs that use it (Mooer Studio, the web editor).");
    let hid: HID.HID;
    try {
      hid = new HID.HID(info.path);
    } catch (e) {
      throw new Error(`Could not open the pedal (is another program using it?): ${e instanceof Error ? e.message : e}`);
    }
    const link = new NodeHidLink(hid, device, onLost);
    hid.on("data", (data: Buffer) => device.receive("USB", new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
    hid.on("error", (e: Error) => link.lost(e.message));
    device.attach(link);
    return link;
  }

  private lost(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.device.detach("USB");
    try {
      this.hid.close();
    } catch {
      /* already gone */
    }
    this.onLost(reason);
  }

  async write(data: Uint8Array): Promise<void> {
    try {
      this.hid.write(hidReport(data));
    } catch (e) {
      this.lost(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.device.detach("USB");
    this.hid.removeAllListeners();
    this.hid.close();
  }
}
