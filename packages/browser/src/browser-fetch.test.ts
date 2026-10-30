import { expect, test } from "bun:test"
import { browserFetch } from "./browser-fetch"

test("uses AlmostNode's saved browser transport without entering its default proxy", async () => {
  // This global is the actual interoperability contract installed by core 0.4.
  const host = globalThis as typeof globalThis & { __almostnodeNativeFetch?: typeof globalThis.fetch }
  const previous = host.__almostnodeNativeFetch
  const requests: string[] = []
  host.__almostnodeNativeFetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response("native transport")
    },
    { preconnect: () => undefined },
  )
  try {
    expect(await (await browserFetch("https://example.test/opentui.wasm")).text()).toBe("native transport")
    expect(requests).toEqual(["https://example.test/opentui.wasm"])
  } finally {
    if (previous) host.__almostnodeNativeFetch = previous
    else delete host.__almostnodeNativeFetch
  }
})
