import type { Tailscale } from "./vendor/tailscale/tailscale"
import { toResponse, toTailscaleRequest } from "./vendor/tailscale/tailscale"

export const CLOUDFLARE_PROXY = "https://bl-cors-proxy.brett-lamy.workers.dev/?url="
export type ProviderConnection =
  | { type: "offline" }
  | { type: "proxy" }
  | { type: "tailscale"; client: Pick<Tailscale, "getSnapshot" | "fetch"> }

/** Only provider/auth HTTP calls enter here; app assets, the in-page SDK and Tailscale control traffic do not. */
export function createProviderFetch(options: {
  connection: () => ProviderConnection
  direct: typeof globalThis.fetch
  onUnavailable?: (message?: string) => void
  proxy?: string
}): typeof globalThis.fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      request.signal.throwIfAborted()
      const target = new URL(request.url)
      if (!/^https?:$/.test(target.protocol) || target.username || target.password)
        throw new Error("Provider requests require an HTTP(S) URL without embedded credentials.")
      const connection = options.connection()
      if (connection.type === "offline") {
        options.onUnavailable?.()
        throw new Error(
          "Choose Tailscale or the Cloudflare CORS proxy using Connection before signing in or sending a message.",
        )
      }
      if (connection.type === "proxy") {
        // Rebuild the request: never send browser cookies to the relay. Streaming responses and cancellation stay native.
        const response = await options.direct((options.proxy ?? CLOUDFLARE_PROXY) + encodeURIComponent(target.href), {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
          signal: request.signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        })
        if (response.status === 403 && response.headers.get("content-type")?.includes("text/html")) {
          const message = `${target.hostname} rejected the Cloudflare relay. Connect Tailscale with an online exit node, then retry your message. Your provider account is still required.`
          options.onUnavailable?.(message)
          await response.body?.cancel()
          return Response.json({ error: { message, type: "browser_connection_error" } }, { status: 403 })
        }
        return response
      }
      const snapshot = connection.client.getSnapshot()
      if (
        snapshot.status !== "connected" ||
        !snapshot.peers.some((peer) => peer.id === snapshot.exitNodeId && peer.exitNode && peer.online)
      ) {
        options.onUnavailable?.()
        throw new Error(
          "Tailscale needs an online exit node. Reconnect using Connection. No request was sent to the public proxy.",
        )
      }
      const tailnetRequest = await toTailscaleRequest(request)
      request.signal.throwIfAborted()
      const current = connection.client.getSnapshot()
      if (
        current.status !== "connected" ||
        current.exitNodeId !== snapshot.exitNodeId ||
        !current.peers.some((peer) => peer.id === current.exitNodeId && peer.online && peer.exitNode)
      )
        throw new Error("The Tailscale exit node changed before this request could be sent. Retry after reconnecting.")
      const pending = connection.client.fetch(tailnetRequest)
      // Go's buffered fetch cannot cancel its underlying I/O. Stop waiting/reading immediately when OpenCode cancels.
      const response = await abortable(pending, request.signal)
      return toResponse(response)
    },
    { preconnect: () => undefined },
  )
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

let connection: ProviderConnection = { type: "offline" }
const listeners = new Set<() => void>()
export function setProviderConnection(next: ProviderConnection) {
  connection = next
  listeners.forEach((listener) => listener())
}
export function getProviderConnection() {
  return connection
}
export function onProviderConnection(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Vite imports this fetch lexically into the provider factory and bundled auth plugins.
// Native OpenCode keeps its normal fetch; the browser never replaces globalThis.fetch.
export function showConnectionMessage(message?: string) {
  window.dispatchEvent(new CustomEvent("opencode:connection-required", { detail: message }))
}

export const fetch = createProviderFetch({
  connection: getProviderConnection,
  direct: globalThis.fetch.bind(globalThis),
  onUnavailable: showConnectionMessage,
})
