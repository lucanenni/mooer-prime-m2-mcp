import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape, z } from "zod";
import { session, PedalError } from "../session";
import type { PrimeM2Device } from "../protocol/device";

export const DATA_DIR = process.env.MOOER_DATA_DIR ?? join(homedir(), "mooer-prime-m2");

export const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
export const failure = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: msg }] });

export interface Hints {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

/** Registers a tool whose handler gets a connected, synced device; errors become tool errors. */
export function tool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  hints: Hints,
  run: (args: z.objectOutputType<S, z.ZodTypeAny>, device: PrimeM2Device) => Promise<unknown>,
  needsPedal = true,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: shape,
      annotations: {
        readOnlyHint: hints.readOnly ?? false,
        destructiveHint: hints.destructive ?? false,
        idempotentHint: hints.idempotent ?? hints.readOnly ?? false,
        openWorldHint: false,
      },
    },
    (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        const device = needsPedal ? await session.ensure() : session.device;
        const result = await run(args, device);
        const issue = device.connectionIssue;
        return text(issue && typeof result === "object" && result ? { ...(result as object), warning: issue } : result);
      } catch (e) {
        return failure(e instanceof Error ? e.message : String(e));
      }
    }) as never,
  );
}

/** Expands ~ and resolves relative paths against the data directory. */
export function dataPath(p: string): string {
  const expanded = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(DATA_DIR, expanded);
}

export function writeFile(path: string, data: Uint8Array | string): string {
  const full = dataPath(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  return full;
}

export const readFile = (path: string): Uint8Array => {
  try {
    return new Uint8Array(readFileSync(dataPath(path)));
  } catch {
    throw new PedalError(`Cannot read file ${dataPath(path)}`);
  }
};

export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
export const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_");
