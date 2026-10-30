import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PluginServerTransport } from "../../src/plugin/server-transport"

test("replaces native plugin transport and returns a real Fetch response without a native server", async () => {
  const fetch = globalThis.fetch.bind(globalThis)
  const transport = { url: () => new URL("data:text/plain,embedded%20transport"), fetch }
  const layer = LayerNode.compile(PluginServerTransport.node, [
    [PluginServerTransport.node, Layer.succeed(PluginServerTransport.Service, { resolve: Effect.succeed(transport) })],
  ])
  const resolved = await Effect.runPromise(
    Effect.flatMap(PluginServerTransport.Service, (service) => service.resolve).pipe(Effect.provide(layer)),
  )

  expect(resolved).toBe(transport)
  expect(resolved.fetch).toBe(fetch)
  const response = await resolved.fetch!(resolved.url()!)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("embedded transport")
})
