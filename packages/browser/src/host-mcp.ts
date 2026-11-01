import type { McpClient } from "@opencode/core/mcp/client"
import { Mcp } from "@opencode/core/mcp/index"
import { Effect, Layer } from "effect"

type Transport = McpClient.Attached["transport"]
type JSONRPCMessage = Parameters<Transport["send"]>[0]

/** A host-owned MCP server. Calls never cross the provider network connection. */
export interface BrowserMcpServer {
  readonly name: string
  readonly version: "1"
  readonly instructions?: string
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown }
  }>
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>
}

export function hostMcpNode(servers: ReadonlyArray<BrowserMcpServer>) {
  return Mcp.node.mapLayer((layer) =>
    Layer.effect(
      Mcp.Service,
      Effect.gen(function* () {
        const mcp = yield* Mcp.Service
        yield* Effect.forEach(servers, (server) => mcp.attach(server.name, createHostMcpTransport(server)), {
          discard: true,
        }).pipe(Effect.orDie)
        return Mcp.Service.of({
          ...mcp,
          // Upstream lists instructions only for configured servers. These come
          // from the trusted embedding host, never from app HTML.
          instructions: () =>
            mcp
              .instructions()
              .pipe(
                Effect.map((configured) => [
                  ...configured.filter((entry) => !servers.some((server) => server.name === entry.server)),
                  ...servers.flatMap((server) =>
                    server.instructions
                      ? [{ server: Mcp.ServerName.make(server.name), instructions: server.instructions }]
                      : [],
                  ),
                ]),
              ),
        })
      }),
    ).pipe(Layer.provide(layer)),
  )
}

/** MCP JSON-RPC over an in-page transport, using OpenCode's ordinary MCP client. */
export function createHostMcpTransport(server: BrowserMcpServer): Transport {
  const calls = new Map<string | number, AbortController>()
  let open = false
  const transport: Transport = {
    async start() {
      open = true
    },
    async close() {
      if (!open) return
      open = false
      for (const call of calls.values()) call.abort()
      calls.clear()
      transport.onclose?.()
    },
    async send(message: JSONRPCMessage) {
      if (!open) throw new Error("Host MCP transport is closed")
      if (!("method" in message)) return
      if (message.method === "notifications/cancelled") {
        const id = message.params?.requestId
        if (typeof id === "string" || typeof id === "number") calls.get(id)?.abort()
        return
      }
      if (!("id" in message)) return
      const id = message.id
      const respond = (result: Record<string, unknown>) => {
        if (open) transport.onmessage?.({ jsonrpc: "2.0", id, result })
      }
      if (message.method === "initialize") {
        respond({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: server.name, version: server.version },
          instructions: server.instructions,
        })
        return
      }
      if (message.method === "ping") return respond({})
      if (message.method === "tools/list") return respond({ tools: server.tools })
      if (message.method !== "tools/call") {
        transport.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
        return
      }
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      if (
        typeof name !== "string" ||
        !server.tools.some((tool) => tool.name === name) ||
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args)
      ) {
        transport.onmessage?.({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid host MCP tool call" } })
        return
      }
      const controller = new AbortController()
      calls.set(id, controller)
      // SDK send() must return before a tool finishes, so cancellation can still arrive.
      void Promise.resolve()
        .then(() => server.callTool(name, args as Record<string, unknown>, controller.signal))
        .then(
          (result) => respond(result),
          (error: unknown) =>
            respond({
              isError: true,
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            }),
        )
        .finally(() => calls.delete(id))
    },
  }
  return transport
}
