import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPresetTools } from "./tools/presets";
import { registerEffectTools } from "./tools/effects";
import { registerSettingsTools } from "./tools/settings";
import { registerLooperTools } from "./tools/looper";
import { registerSampleTools } from "./tools/samples";
import { session } from "./session";

const server = new McpServer(
  { name: "mooer-prime-m2", version: "0.1.0" },
  {
    instructions:
      "Controls a Mooer Prime M2 pedal over USB. Edits to effects go to the pedal's edit buffer and are lost when another preset is selected unless stored with save_preset. " +
      "Pedal-wide settings (mixer, tuner, drum, global...) apply immediately. Only one program can use the pedal at a time: close Mooer Studio and the web editor first. " +
      "Slots are 1-based chain positions; presets are 1-80 (label 0A = 1). Operations that replace stored data back up the old content under the data directory.",
  },
);

registerPresetTools(server);
registerEffectTools(server);
registerSettingsTools(server);
registerLooperTools(server);
registerSampleTools(server);

await server.connect(new StdioServerTransport());
process.stderr.write(`mooer-prime-m2 MCP ready${session.demo ? " (demo pedal)" : ""}\n`);
const shutdown = () => session.close().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
