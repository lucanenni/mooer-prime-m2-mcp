// One shared connection to the pedal for the whole MCP server, opened on demand.

import { PrimeM2Device } from "./protocol/device";
import { NodeHidLink } from "./transport/nodehid";
import { attachDemoPedal } from "./demo/fakePedal";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PedalError extends Error {}

class Session {
  readonly device = new PrimeM2Device((m) => process.stderr.write(`[m2] ${m}\n`));
  private link?: NodeHidLink;
  private connecting?: Promise<void>;
  readonly demo = process.env.MOOER_DEMO === "1";

  /** Connects if needed and returns the synced device. */
  async ensure(): Promise<PrimeM2Device> {
    const d = this.device;
    if (!d.link || !d.isReady) {
      this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
      await this.connecting;
    }
    return d;
  }

  private async connect(): Promise<void> {
    const d = this.device;
    if (!d.link) {
      if (this.demo) attachDemoPedal(d, true);
      else this.link = NodeHidLink.connect(d, (reason) => process.stderr.write(`[m2] link lost: ${reason}\n`));
    }
    await this.waitFor(() => d.isReady && d.activePresetIndex !== undefined && d.preset !== undefined, 10_000, "the pedal to answer");
  }

  async waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > end) throw new PedalError(`Timed out waiting for ${what}.${this.device.connectionIssue ? " " + this.device.connectionIssue : ""}`);
      await sleep(25);
    }
  }

  /** Waits until every queued command has been answered. */
  async settle(timeoutMs = 10_000): Promise<void> {
    await sleep(15);
    await this.waitFor(() => !this.device.isBusy, timeoutMs, "the pedal to finish");
  }

  /** Re-reads the active preset's edit buffer so the result reflects what the pedal holds. */
  async reloadActive(): Promise<void> {
    const d = this.device;
    if (d.activePresetIndex === undefined) return;
    d.preset = undefined;
    d.loadPreset(d.activePresetIndex);
    await this.waitFor(() => d.preset !== undefined, 5000, "the preset");
    await this.settle();
  }

  async close(): Promise<void> {
    await this.link?.close();
  }
}

export const session = new Session();
export { sleep };
