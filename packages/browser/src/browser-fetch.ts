// AlmostNode 0.4 wraps global fetch for its command runtime. Its saved native
// fetch is the transport for application assets and the explicitly chosen
// provider connection, so those requests never enter the container's proxy.
const initial = globalThis.fetch.bind(globalThis)

export const browserFetch: typeof globalThis.fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const native = (globalThis as typeof globalThis & { __almostnodeNativeFetch?: typeof globalThis.fetch })
      .__almostnodeNativeFetch
    return (native ?? initial)(input, init)
  },
  { preconnect: () => undefined },
)
