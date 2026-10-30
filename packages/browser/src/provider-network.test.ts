import { afterAll, expect, test } from "bun:test"
import { createProviderFetch, type ProviderConnection } from "./provider-network"
import { createTailscale } from "./vendor/tailscale/tailscale"

let requests = 0
let finish: (() => void) | undefined
const received: Array<{ target: string | null; auth: string | null; body: string; cookies: string | null }> = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requests++
    received.push({
      target: new URL(request.url).searchParams.get("url"),
      auth: request.headers.get("authorization"),
      body: await request.text(),
      cookies: request.headers.get("cookie"),
    })
    if (request.headers.has("x-stream-test")) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"))
            finish = () => {
              controller.enqueue(new TextEncoder().encode("data: last\n\n"))
              controller.close()
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({ ok: true })
  },
})
afterAll(() => server.stop(true))
const route = (connection: ProviderConnection) =>
  createProviderFetch({
    connection: () => connection,
    direct: globalThis.fetch,
    proxy: server.url.href + "?url=",
  })

test("unselected connection blocks provider traffic", async () => {
  const before = requests
  await expect(route({ type: "offline" })("https://auth.openai.com/oauth/token")).rejects.toThrow("Choose Tailscale")
  expect(requests).toBe(before)
})

test("the proxy receives the encoded provider target, authentication and original POST body", async () => {
  const response = await route({ type: "proxy" })(
    new Request("https://auth.openai.com/oauth/token?scope=a%2Fb", {
      method: "POST",
      headers: { authorization: "Bearer test-fixture-only", "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=fixture",
    }),
  )
  expect(await response.json()).toEqual({ ok: true })
  expect(received.at(-1)).toEqual({
    target: "https://auth.openai.com/oauth/token?scope=a%2Fb",
    auth: "Bearer test-fixture-only",
    body: "grant_type=authorization_code&code=fixture",
    cookies: null,
  })
})

test("proxy responses remain streamed instead of waiting for the whole reply", async () => {
  const response = await route({ type: "proxy" })("https://chatgpt.com/backend-api/codex/responses", {
    headers: { "x-stream-test": "yes" },
  })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n")
  finish!()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: last\n\n")
  expect((await reader.read()).done).toBe(true)
})

test("a disconnected private connection never falls back to the proxy", async () => {
  const before = requests
  const client = createTailscale()
  await expect(route({ type: "tailscale", client })("https://chatgpt.com/backend-api/codex/responses")).rejects.toThrow(
    "online exit node",
  )
  expect(requests).toBe(before)
  await client.dispose()
})

test("cancelled requests stop before sending credentials", async () => {
  const before = requests
  await expect(
    route({ type: "proxy" })("https://auth.openai.com/oauth/token", { signal: AbortSignal.abort() }),
  ).rejects.toThrow()
  expect(requests).toBe(before)
})
