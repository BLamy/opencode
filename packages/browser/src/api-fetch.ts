// The client talks to the in-page HTTP application. Provider traffic uses the
// separate connection selected by the user in provider-network.ts.
const backends = new Map<string, typeof globalThis.fetch>()

export function registerApiFetch(url: string, fetch: typeof globalThis.fetch) {
  const origin = new URL(url).origin
  backends.set(origin, fetch)
  return () => {
    if (backends.get(origin) === fetch) backends.delete(origin)
  }
}

export const noTimeoutFetch: typeof globalThis.fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return (backends.get(url.origin) ?? globalThis.fetch.bind(globalThis))(input, init)
  },
  { preconnect: () => {} },
)
