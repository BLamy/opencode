import { expect, test } from "bun:test"
import { createHostMcpTransport, type BrowserMcpServer } from "./host-mcp"

const server: BrowserMcpServer = {
  name: "agent-browser",
  version: "1",
  instructions: "Only the app iframe.",
  tools: [{ name: "agent_browser_snapshot", description: "Read the iframe.", inputSchema: { type: "object" } }],
  callTool: async () => ({ content: [{ type: "text", text: "button Increment [ref=e1]" }] }),
}

test("host MCP negotiates, lists and executes tools over JSON-RPC", async () => {
  const transport = createHostMcpTransport(server)
  const messages: unknown[] = []
  transport.onmessage = (message) => messages.push(message)
  await transport.start()
  try {
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    const completed = Promise.withResolvers<void>()
    transport.onmessage = (message) => {
      messages.push(message)
      completed.resolve()
    }
    await transport.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "agent_browser_snapshot", arguments: {} },
    })
    await completed.promise
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-browser", version: "1" },
          instructions: "Only the app iframe.",
        },
      },
      { jsonrpc: "2.0", id: 2, result: { tools: server.tools } },
      { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "button Increment [ref=e1]" }] } },
    ])
  } finally {
    await transport.close()
  }
})

test("host MCP reports invalid tools, tool failures, cancellation and disposal", async () => {
  const called = Promise.withResolvers<AbortSignal>()
  const transport = createHostMcpTransport({
    ...server,
    callTool: async (_, args, signal) => {
      if (args.fail) throw new Error("Preview closed")
      called.resolve(signal)
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return { content: [{ type: "text", text: "cancelled" }] }
    },
  })
  const messages: unknown[] = []
  transport.onmessage = (message) => messages.push(message)
  await transport.start()
  await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "missing", arguments: {} } })
  expect(messages[0]).toMatchObject({ id: 1, error: { code: -32602 } })
  const failed = Promise.withResolvers<void>()
  transport.onmessage = (message) => {
    messages.push(message)
    failed.resolve()
  }
  await transport.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "agent_browser_snapshot", arguments: { fail: true } },
  })
  await failed.promise
  expect(messages[1]).toMatchObject({
    id: 2,
    result: { isError: true, content: [{ type: "text", text: "Preview closed" }] },
  })
  await transport.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "agent_browser_snapshot", arguments: {} },
  })
  const signal = await called.promise
  await transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } })
  expect(signal.aborted).toBe(true)
  await transport.close()
  await expect(transport.send({ jsonrpc: "2.0", id: 4, method: "ping" })).rejects.toThrow("closed")
})
