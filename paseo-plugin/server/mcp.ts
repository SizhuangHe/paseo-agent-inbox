// A small MCP server (Streamable HTTP, JSON responses only) inside the plugin process.
//
// Paseo delivers plugin agent tools only when `daemon.mcp.injectIntoAgents` is on, which also
// hands every agent the whole Paseo tool catalog. Plugin-owned MCP servers from
// `agent.open.before` are delivered regardless, so the queue tools travel that way instead.
//
// Each session gets its own URL (/mcp/<agentId>) and a bearer token derived from the agent id,
// so the session identity comes from the launch configuration, never from the agent's input.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { PaseoApi } from "./host";
import type { QueueTool } from "./tools";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1_000_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
}

export class QueueMcpServer {
  #server: Server | null = null;
  #port: number | null = null;
  #secret = randomBytes(32);
  #tools: QueueTool[];
  #paseo: () => PaseoApi | null;

  constructor(tools: QueueTool[], paseo: () => PaseoApi | null) {
    this.#tools = tools;
    this.#paseo = paseo;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        console.error("[agent-queue] MCP request failed", error);
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  endpointFor(agentId: string): McpEndpoint {
    if (this.#port === null) throw new Error("agent-queue MCP server is not running");
    return {
      url: `http://127.0.0.1:${this.#port}/mcp/${encodeURIComponent(agentId)}`,
      headers: { Authorization: `Bearer ${this.#token(agentId)}` },
    };
  }

  #token(agentId: string): string {
    return createHmac("sha256", this.#secret).update(agentId).digest("hex");
  }

  #authorized(agentId: string, header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.#token(agentId)}`);
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([^/?#]+)/.exec(request.url ?? "");
    if (!match) return void response.writeHead(404).end();
    const agentId = decodeURIComponent(match[1]);
    if (!this.#authorized(agentId, request.headers.authorization)) return void response.writeHead(401).end();
    if (request.method !== "POST") return void response.writeHead(405, { Allow: "POST" }).end();

    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      return void sendJson(response, 400, rpcError(null, -32700, "Parse error"));
    }
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcMessage[];
    const replies: unknown[] = [];
    for (const message of messages) {
      if (message.id === undefined || message.id === null || !message.method) continue; // notifications, responses
      replies.push(await this.#dispatch(agentId, message));
    }
    if (!replies.length) return void response.writeHead(202).end();
    sendJson(response, 200, Array.isArray(body) ? replies : replies[0]);
  }

  async #dispatch(agentId: string, message: JsonRpcMessage): Promise<unknown> {
    const id = message.id ?? null;
    switch (message.method) {
      case "initialize": {
        const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "";
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-queue", version: "0.1.0" },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: this.#tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
          })),
        });
      case "tools/call": {
        const name = message.params?.name;
        const tool = this.#tools.find((candidate) => candidate.name === name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        const parsed = tool.input.safeParse(message.params?.arguments ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
          return rpcResult(id, { content: [{ type: "text", text: `Invalid input: ${issues.join("; ")}` }], isError: true });
        }
        try {
          const result = await tool.run(parsed.data, { agentId, paseo: this.#paseo() });
          return rpcResult(id, { content: [{ type: "text", text: result.text }], isError: result.isError ?? false });
        } catch (error) {
          console.error("[agent-queue] tool failed", name, error);
          const text = error instanceof Error ? error.message : String(error);
          return rpcResult(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${String(message.method)}`);
    }
  }
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
