export * as PluginServerTransport from "./server-transport"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

export interface Transport {
  readonly url: () => URL | undefined
  readonly fetch?: typeof globalThis.fetch
}

export class Service extends Context.Service<Service, { readonly resolve: Effect.Effect<Transport> }>()(
  "@opencode/PluginServerTransport",
) {}

const layer = Layer.succeed(Service, {
  resolve: Effect.promise(async () => {
    // Keep the native server import at the same lazy plugin initialization
    // boundary. Embedded hosts replace this service with their own handler.
    const { Server } = await import("../server/server")
    const fetch = Server.url
      ? undefined
      : Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => Server.Default().app.fetch(new Request(input, init)),
          { preconnect: () => undefined },
        )
    return { url: () => Server.url, fetch }
  }),
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
