import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "@sieve/daemon";
import { SIEVE_VERSION, TOOLS, type ToolResult } from "@sieve/protocol";
import { z } from "zod";

/** JSON Schemas for every tool, generated from the zod schemas (one source of truth). */
export function toolList() {
  return Object.entries(TOOLS).map(([name, def]) => {
    const { $schema: _s, ...inputSchema } = z.toJSONSchema(def.schema, { io: "input" }) as Record<
      string,
      unknown
    >;
    return { name, description: def.description, inputSchema: { type: "object", ...inputSchema } };
  });
}

/**
 * The MCP stdio server is a thin proxy: it holds no state and forwards every call to the
 * daemon, starting it if needed. All agents share the daemon's warm state.
 */
export async function runMcpServer(): Promise<void> {
  let client: DaemonClient | null = null;
  const getClient = async () => {
    client ??= await DaemonClient.connect({ autostart: true, waitMs: 3000 });
    return client;
  };

  const server = new Server({ name: "sieve", version: SIEVE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const call = async () => {
      const c = await getClient();
      if (!c) return null;
      return c.request(
        {
          type: "tool",
          tool: req.params.name,
          args: req.params.arguments ?? {},
          cwd: process.cwd(),
          client: `sieve-mcp/${SIEVE_VERSION}`,
        },
        620_000,
      );
    };
    let reply = await call();
    if (reply && !reply.ok && reply.error.message === "connection closed") {
      client = null; // daemon restarted (idle shutdown, upgrade): reconnect once
      reply = await call();
    }
    if (!reply) {
      return {
        content: [{ type: "text", text: "Sieve daemon is not reachable. Run `sieve doctor` in a terminal." }],
        isError: true,
      };
    }
    if (!reply.ok)
      return {
        content: [{ type: "text", text: `Error (${reply.error.code}): ${reply.error.message}` }],
        isError: true,
      };
    const r = reply.result as ToolResult;
    return { content: [{ type: "text", text: r.content }], isError: r.isError };
  });
  await server.connect(new StdioServerTransport());
}
