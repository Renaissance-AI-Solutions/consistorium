/**
 * Streamable HTTP transport for Consistorium.
 *
 * Default posture for a private single-founder deployment:
 * - bind 127.0.0.1
 * - require a bearer token unless --allow-anonymous on loopback
 * - hide/disable write tools unless --allow-writes
 * - never log tool result bodies
 */
import * as crypto from "node:crypto";
import * as http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bootstrap, createMcpServer, type BridgeRuntime } from "./app.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface HttpListenOptions {
  host?: string;
  port?: number;
  token?: string;
  allowAnonymous?: boolean;
  allowWrites?: boolean;
  runtime?: BridgeRuntime;
  allowedHosts?: string[];
}

export interface StartedHttpServer {
  url: string;
  host: string;
  port: number;
  token?: string;
  allowWrites: boolean;
  close: () => Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").split("%")[0] ?? host;
  return LOOPBACK.has(host) || LOOPBACK.has(bare) || bare === "::1";
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function extractBearer(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1];
}

function hostnameOf(reqHost: string): string {
  if (reqHost.startsWith("[")) {
    const end = reqHost.indexOf("]");
    return end >= 0 ? reqHost.slice(0, end + 1) : reqHost;
  }
  const idx = reqHost.lastIndexOf(":");
  return idx === -1 ? reqHost : reqHost.slice(0, idx);
}

function hostHeaderAllowed(reqHost: string | undefined, bindHost: string, port: number, extra: string[]): boolean {
  if (!reqHost) return false;
  const header = reqHost.toLowerCase();
  const hostname = hostnameOf(header);
  if (isLoopbackHost(bindHost) && isLoopbackHost(hostname)) return true;
  const allowed = new Set<string>(extra.map((h) => h.toLowerCase()));
  const add = (value: string) => {
    allowed.add(value.toLowerCase());
    if (!value.includes(":")) allowed.add(`${value.toLowerCase()}:${port}`);
  };
  add(bindHost);
  return allowed.has(header) || allowed.has(hostname);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function validateHttpOptions(opts: HttpListenOptions): { host: string; allowAnonymous: boolean; token?: string } {
  const host = opts.host ?? "127.0.0.1";
  const allowAnonymous = opts.allowAnonymous === true;
  const token =
    opts.token?.trim() ||
    process.env.CONSISTORIUM_TOKEN?.trim() ||
    process.env.CONTEXT_BRIDGE_TOKEN?.trim() ||
    undefined;

  if (!isLoopbackHost(host) && allowAnonymous) {
    throw Object.assign(new Error("Refusing --allow-anonymous on a non-loopback bind. Use a bearer token."), {
      code: "INSECURE_BIND",
    });
  }
  if (!isLoopbackHost(host) && !token) {
    throw Object.assign(new Error("Refusing to listen on a non-loopback address without CONSISTORIUM_TOKEN / --token."), {
      code: "INSECURE_BIND",
    });
  }
  return { host, allowAnonymous, token };
}

export async function startHttpServer(opts: HttpListenOptions = {}): Promise<StartedHttpServer> {
  const { host, allowAnonymous, token: configuredToken } = validateHttpOptions(opts);
  const port = opts.port ?? 8787;
  const token = configuredToken ?? (allowAnonymous ? undefined : generateToken());
  const allowWrites =
    opts.allowWrites === true ||
    process.env.CONSISTORIUM_HTTP_WRITES === "1" ||
    process.env.CONTEXT_BRIDGE_HTTP_WRITES === "1";
  const runtime = opts.runtime ?? bootstrap({ allowWrites });
  runtime.allowWrites = allowWrites;

  const allowedHosts = opts.allowedHosts ?? [];
  const bound = { port };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${bound.port}`}`);

    if (!hostHeaderAllowed(req.headers.host, host, bound.port, allowedHosts)) {
      sendJson(res, 421, { error: "invalid host header", code: "INVALID_HOST" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, name: "consistorium", transport: "streamable-http" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        name: "consistorium",
        transport: "streamable-http",
        mcp: "/mcp",
        health: "/healthz",
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (token) {
      const provided = extractBearer(req.headers.authorization);
      if (!provided || !tokensEqual(provided, token)) {
        sendJson(
          res,
          401,
          { error: "missing or invalid bearer token", code: "UNAUTHORIZED" },
          { "WWW-Authenticate": 'Bearer realm="consistorium"' }
        );
        return;
      }
    }

    if (req.method === "GET" || req.method === "DELETE") {
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST /mcp (stateless Streamable HTTP)." },
        id: null,
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    const mcp = createMcpServer(runtime);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[consistorium] HTTP MCP error:", (error as Error).message);
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    } finally {
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  bound.port = actualPort;
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}/mcp`;

  console.error(
    `[consistorium] Streamable HTTP on ${url} (bind=${host} writes=${allowWrites ? "on" : "off"} auth=${token ? "bearer" : "anonymous-loopback"})`
  );
  if (token && !configuredToken && !process.env.CONSISTORIUM_TOKEN && !process.env.CONTEXT_BRIDGE_TOKEN) {
    console.error(`[consistorium] Generated bearer token (set CONSISTORIUM_TOKEN to pin it): ${token}`);
  }

  return {
    url,
    host,
    port: actualPort,
    token,
    allowWrites,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
