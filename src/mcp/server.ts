#!/usr/bin/env node
/**
 * Consistorium MCP server — stdio transport entrypoint.
 *
 * The portable core lives in ./app.ts and is shared with Streamable HTTP.
 *
 * Uses a batch-tolerant stdio transport: some clients (e.g. OpenAI's Secure
 * MCP Tunnel gateway) deliver JSON-RPC messages as batched arrays. The stock
 * StdioServerTransport cannot parse arrays, throws, and closes the stream
 * without responding — which surfaces upstream as an unexplained 502. This
 * transport splits each line's payload into individual messages instead.
 */
import { pathToFileURL } from "node:url";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { bootstrap, createMcpServer } from "./app.js";

export interface StdioServerOptions {
  allowWrites?: boolean;
}

class BatchTolerantStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  private started = false;

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("BatchTolerantStdioTransport already started!");
    }
    this.started = true;
    process.stdin.setEncoding("utf8");
    let pending = "";
    process.stdin.on("data", (chunk: string) => {
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (line.trim().length > 0) this.dispatchLine(line);
      }
    });
    process.stdin.on("error", (error: Error) => this.onerror?.(error));
    const onEnd = () => this.close().catch(() => {});
    process.stdin.on("end", onEnd);
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // JSON-RPC batch: validate and forward each element as its own message.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      try {
        const message = JSONRPCMessageSchema.parse(item);
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async send(message: unknown): Promise<void> {
    return new Promise((resolve) => {
      const json = `${JSON.stringify(message)}\n`;
      if (process.stdout.write(json)) {
        resolve();
      } else {
        process.stdout.once("drain", resolve);
      }
    });
  }

  async close(): Promise<void> {
    process.stdin.pause();
    this.onclose?.();
  }
}

async function main(options: StdioServerOptions = {}) {
  const allowWrites = options.allowWrites !== false;
  const runtime = bootstrap({ allowWrites });
  const server = createMcpServer(runtime);
  const transport = new BatchTolerantStdioTransport();
  await server.connect(transport);
  console.error(
    `[consistorium] MCP stdio server running. Config: ${runtime.config.configPath} Projects: ${runtime.config.projects.length} Writes: ${allowWrites ? "on" : "off"}`
  );
}

const invokedAsStdioEntry =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsStdioEntry || process.env.CONSISTORIUM_FORCE_STDIO === "1" || process.env.CONTEXT_BRIDGE_FORCE_STDIO === "1") {
  main().catch((e) => {
    console.error("[consistorium] Fatal:", e);
    process.exit(1);
  });
}

export { main as startStdioServer };
