/* ══ The real tailnet client: Tailscale's Go code as WebAssembly ══
   Adapts `@agent-wasm/tailscale-connect` — the fork of Tailscale's `cmd/tsconnect` package that almostnode builds
   (BSD-3-Clause, Tailscale Inc.; github.com/blamy/almostnode, packages/tailscale-connect) — to `TailscaleClient`.
   The package is an optional peer dependency, imported only when `start()` runs, and its `main.wasm` is about 26 MB:
   host it yourself and pass its URL (`wasmURL`), the way almostnode does with Vite's `?url` import.

   What it relies on (from the package's pkg.d.ts and almostnode's worker; not exercised against a real tailnet here):
     createIPN({ authKey, controlURL, hostname, stateStorage, wasmURL, panicHandler }) → ipn
     ipn.run({ notifyState, notifyNetMap, notifyBrowseToURL, notifyPanicRecover })
     ipn.login() / ipn.logout()
     ipn.fetch(url | { url, method, headers, bodyBase64, redirect }) → { status, statusText, headers, bodyBase64 }
   Browsers cannot send UDP, so every packet is relayed over Tailscale's DERP servers on WebSockets; there are no direct
   connections. Bodies are buffered (base64) both ways, so nothing streams. almostnode runs the client in a dedicated
   Worker with shims around it; this adapter runs it where you call it (the main thread, unless you construct it in a worker
   yourself). Tailnet names resolve in the client (MagicDNS). Through an exit node, a public name is looked up over
   DNS-over-HTTPS and given to the client as `ipMap`, as almostnode does (see `dnsVia`). */

import type {
  TailscaleClient,
  TailscaleClientState,
  TailscaleNetMap,
  TailscaleRequest,
  TailscaleResponse,
} from "./tailscale"

/** The slice of the package's IPN this uses (structural, so this file's types do not depend on it). */
export interface TailscaleIpn {
  run(callbacks: {
    notifyState: (state: TailscaleClientState) => void
    notifyNetMap: (netMap: string) => void
    notifyBrowseToURL: (url: string) => void
    notifyPanicRecover: (error: string) => void
  }): void
  login(): void
  logout(): void
  /** Applies prefs at runtime (the exit node). Not every build has it. */
  configure?(config: Record<string, unknown>): Promise<void>
  fetch(
    request:
      | string
      | {
          url: string
          method?: string
          headers?: Record<string, string>
          bodyBase64?: string
          redirect?: RequestRedirect
          tlsServerName?: string
        },
  ): Promise<{
    url?: string
    status: number
    statusText?: string
    headers?: Record<string, string>
    bodyBase64?: string
    text?: () => Promise<string>
  }>
}

export interface TailscaleConnectModule {
  createIPN(config: {
    authKey: string
    controlURL?: string
    hostname?: string
    stateStorage?: { getState(id: string): string; setState(id: string, value: string): void }
    wasmURL?: string
    panicHandler: (error: string) => void
    /** DNS settings; almostnode passes each in camelCase and PascalCase because the Go side reads the latter. */
    [setting: string]: unknown
  }): Promise<TailscaleIpn>
}

export interface TailscaleConnectOptions {
  /** Where `main.wasm` is served (for Vite: `import wasmURL from '@agent-wasm/tailscale-connect/main.wasm?url'`). */
  wasmURL: string
  /** Loads the package. Default `import('@agent-wasm/tailscale-connect')`. */
  load?: () => Promise<TailscaleConnectModule>
  /** Use the tailnet's DNS (MagicDNS at 100.100.100.100) so names like `nas.tail1234.ts.net` resolve inside the client. Default true.
   *  almostnode found name-based fetches failing in the WebAssembly runtime without it; this sends the settings it sends. */
  acceptDns?: boolean
  /** A DNS-over-HTTPS (JSON) endpoint for public host names while an exit node is in use. The client cannot resolve them itself,
   *  so the name is looked up here and handed to the client as `ipMap` (the way almostnode does it). Default
   *  `https://cloudflare-dns.com/dns-query`, or `https://1.1.1.1/dns-query` with `dnsVia: 'exit-node'`. */
  dohUrl?: string
  /** Where that lookup is sent. `page` (default, as almostnode does): the page's own network, which leaks the names you visit to the
   *  DNS server. `exit-node`: through the tailnet client, so through the exit node; it needs an IP-literal `dohUrl`. */
  dnsVia?: "page" | "exit-node"
  /** The `fetch` for a `page` lookup. Default `globalThis.fetch`. */
  dnsFetch?: typeof fetch
  /** How a public name is fetched through an exit node. `address` (default): dial the looked-up address, keeping the name as
   *  the Host header and TLS server name. `name`: fetch the name with the address handed over as `ipMap`, falling back to the
   *  address. The bundled Go build panics (a nil connection closed in its dial race) when a name resolves to several
   *  addresses and one dial fails, so the name path is opt-in. */
  exitNodeDial?: "address" | "name"
  /** Root certificates (PEM) the client verifies TLS with. The Go runtime in a browser has no certificate store, so without
   *  them every HTTPS fetch fails with "x509: certificate signed by unknown authority". Default: Mozilla's CA store
   *  (lib/tailscale-roots, ~180 KB, loaded with the client). A function is called once, at start. */
  caCertificates?: string | (() => Promise<string>)
}

/** Where the client reads its root certificates: Go's x509 on js/wasm reads `SSL_CERT_FILE`, through `globalThis.fs`. */
export const TAILSCALE_CERT_FILE = "/etc/ssl/cert.pem"

type GoFs = Record<string, unknown> & {
  open?: (path: string, flags: number, mode: number, cb: (err: unknown, fd?: number) => void) => void
  read?: (
    fd: number,
    buf: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
    cb: (err: unknown, n?: number) => void,
  ) => void
  fstat?: (fd: number, cb: (err: unknown, stat?: unknown) => void) => void
  stat?: (path: string, cb: (err: unknown, stat?: unknown) => void) => void
  lstat?: (path: string, cb: (err: unknown, stat?: unknown) => void) => void
  close?: (fd: number, cb: (err: unknown) => void) => void
}

let rootsBytes: Uint8Array | null = null

/** Gives the Go runtime the root certificates: a read-only file at TAILSCALE_CERT_FILE in its `fs` (the package's own `fs` is a
 *  stub that fails every call, so x509 finds no roots), and SSL_CERT_FILE in the environment of every `Go` it creates. The
 *  way almostnode's worker does it, without a whole virtual file system. Idempotent; later calls replace the bundle. */
export function installTailscaleRoots(pem: string) {
  rootsBytes = new TextEncoder().encode(pem)
  const g = globalThis as { Go?: new () => { env?: Record<string, string> }; fs?: GoFs }
  if (typeof g.Go === "function" && !(g.Go as { blRoots?: boolean }).blRoots) {
    const Base = g.Go
    const WithRoots = class extends Base {
      static blRoots = true
      constructor() {
        super()
        this.env = { ...this.env, SSL_CERT_FILE: TAILSCALE_CERT_FILE }
      }
    }
    g.Go = WithRoots
  }
  const base = g.fs
  if (!base || base.blRoots) return
  const files = new Map<number, { pos: number }>()
  let nextFd = 0x7f00
  // Shaped like Node's fs.Stats: Go's syscall.Open calls `isDirectory()` on what fstat returns (fs_js.go), and a missing
  // method is a panic that ends the runtime on the first HTTPS fetch.
  const stat = () => {
    const now = Date.now()
    return {
      dev: 0,
      ino: 0,
      mode: 0o100444,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: rootsBytes!.length,
      blksize: 4096,
      blocks: Math.ceil(rootsBytes!.length / 512),
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    }
  }
  const ours = (path: string) => path === TAILSCALE_CERT_FILE && rootsBytes !== null
  g.fs = Object.assign(Object.create(base) as GoFs, {
    blRoots: true,
    open(path: string, flags: number, mode: number, cb: (err: unknown, fd?: number) => void) {
      if (!ours(path)) return base.open?.(path, flags, mode, cb)
      const fd = nextFd++
      files.set(fd, { pos: 0 })
      cb(null, fd)
    },
    fstat(fd: number, cb: (err: unknown, stat?: unknown) => void) {
      if (!files.has(fd)) return base.fstat?.(fd, cb)
      cb(null, stat())
    },
    stat(path: string, cb: (err: unknown, stat?: unknown) => void) {
      if (!ours(path)) return base.stat?.(path, cb)
      cb(null, stat())
    },
    lstat(path: string, cb: (err: unknown, stat?: unknown) => void) {
      if (!ours(path)) return base.lstat?.(path, cb)
      cb(null, stat())
    },
    read(
      fd: number,
      buf: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
      cb: (err: unknown, n?: number) => void,
    ) {
      const file = files.get(fd)
      if (!file) return base.read?.(fd, buf, offset, length, position, cb)
      const from = position ?? file.pos
      const chunk = rootsBytes!.subarray(from, from + length)
      buf.set(chunk, offset)
      if (position === null) file.pos = from + chunk.length
      cb(null, chunk.length)
    },
    close(fd: number, cb: (err: unknown) => void) {
      if (!files.delete(fd)) return base.close?.(fd, cb)
      cb(null)
    },
  })
}

/** Records the WebSockets a client instance opens (control, DERP), so a dead instance's can be closed: after a Go panic their
 *  callbacks would each throw "Go program has already exited". Returns a function that closes them and stops recording. */
function trackSockets(): () => void {
  const Original = globalThis.WebSocket
  if (typeof Original !== "function") return () => {}
  const open = new Set<WebSocket>()
  const Tracked = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const ws = new Original(url, protocols)
    if (/(^|\.)tailscale\.com$|derp/i.test(new URL(String(url), "https://x").hostname)) {
      open.add(ws)
      ws.addEventListener("close", () => open.delete(ws))
    }
    return ws
  } as unknown as typeof WebSocket
  Object.assign(Tracked, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  Tracked.prototype = Original.prototype
  globalThis.WebSocket = Tracked
  return () => {
    if (globalThis.WebSocket === Tracked) globalThis.WebSocket = Original
    for (const ws of open) {
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    }
    open.clear()
  }
}

/** The client keeps its prefs as hex-encoded JSON under `profile-…` keys, and a login can write `CorpDNS: false` back;
 *  almostnode rewrites it to true on the way in (its worker's stateStorage.setState), and so does this. */
export function keepCorpDns(id: string, value: string): string {
  if (!id.startsWith("profile-") || !value || value.length % 2) return value
  try {
    const bytes = new Uint8Array(value.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
    const prefs: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!prefs || typeof prefs !== "object" || (prefs as { CorpDNS?: unknown }).CorpDNS !== false) return value
    const out = new TextEncoder().encode(JSON.stringify({ ...prefs, CorpDNS: true }, null, "\t"))
    return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("")
  } catch {
    return value // not a JSON profile: leave it alone
  }
}

/** The DNS part of createIPN's config, as almostnode sends it (tailscale-connect-worker.ts, createWorkerIpn). */
function dnsSettings(on: boolean): Record<string, unknown> {
  return {
    acceptDns: on,
    corpDns: on,
    corpDNS: on,
    CorpDNS: on,
    dns: on,
    dnsIP: on ? "100.100.100.100" : null,
    bootstrapDns: on ? ["100.100.100.100", "fd7a:115c:a1e0::53"] : [],
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** What to send the client (as `configure`, or inside `createIPN`) to use, or stop using, an exit node. The Go side reads the
    PascalCase names and the types document the camelCase ones; almostnode sends both, so this does. Exit-node mode needs the
    tailnet's DNS on, since there is no host resolver behind the WebAssembly client. */
export function exitNodeSettings(id: string | null): Record<string, unknown> {
  const on = id !== null
  return {
    useExitNode: on,
    routeAll: on,
    RouteAll: on,
    exitNodeId: id,
    exitNodeID: id,
    ExitNodeID: id,
    ...dnsSettings(true),
  }
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** A name that needs public DNS: not an address, not a tailnet (`*.ts.net`) or MagicDNS short name, not loopback. */
export function isPublicName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "")
  return (
    h.includes(".") &&
    !IPV4.test(h) &&
    !h.includes(":") &&
    !h.startsWith("[") &&
    !h.endsWith(".ts.net") &&
    h !== "localhost" &&
    !h.endsWith(".localhost")
  )
}

/** A `TailscaleClient` over `@agent-wasm/tailscale-connect`. Nothing loads until `start()`. */
export function createTailscaleConnectClient(options: TailscaleConnectOptions): TailscaleClient {
  let ipn: TailscaleIpn | null = null
  let disposed = false
  let exitNodeId: string | null = null
  let releaseSockets: () => void = () => {}
  /** Public host name → address and when to forget it. Cleared whenever the exit node changes. */
  const addresses = new Map<string, { ip: string; until: number }>()
  /** What the client has been told: host name → address. It dials the address for the name (keeping the name for Host and TLS). */
  const ipMap: Record<string, string> = {}

  /** An A record for `host` from a DNS-over-HTTPS server: over the page's network (almostnode's way), or through the exit node. */
  async function resolvePublic(host: string): Promise<string> {
    const hit = addresses.get(host)
    if (hit && hit.until > Date.now()) return hit.ip
    const viaExit = options.dnsVia === "exit-node"
    const endpoint = new URL(
      options.dohUrl ?? (viaExit ? "https://1.1.1.1/dns-query" : "https://cloudflare-dns.com/dns-query"),
    )
    endpoint.searchParams.set("name", host)
    endpoint.searchParams.set("type", "A")
    let status: number
    let text: string
    if (viaExit) {
      if (!ipn) throw new Error("The Tailscale client is not running.")
      const res = await ipn.fetch({ url: endpoint.href, headers: { accept: "application/dns-json" } })
      status = res.status
      text = res.text ? await res.text() : new TextDecoder().decode(base64ToBytes(res.bodyBase64 ?? ""))
    } else {
      const res = await (options.dnsFetch ?? globalThis.fetch.bind(globalThis))(endpoint.href, {
        headers: { accept: "application/dns-json" },
      })
      status = res.status
      text = await res.text()
    }
    if (status !== 200) throw new Error(`DNS lookup for ${host} failed (HTTP ${status}).`)
    const answer = (
      JSON.parse(text) as { Answer?: Array<{ type?: number; data?: string; TTL?: number }> }
    ).Answer?.find((a) => a.type === 1 && typeof a.data === "string" && IPV4.test(a.data))
    if (!answer?.data) throw new Error(`${host} has no address to look up.`)
    addresses.set(host, { ip: answer.data, until: Date.now() + Math.min(Math.max(answer.TTL ?? 60, 30), 300) * 1000 })
    return answer.data
  }

  /** The exit node, DNS and address map, applied together (almostnode sends the whole config each time). */
  const applyConfig = () =>
    ipn?.configure?.({ ...exitNodeSettings(exitNodeId), ...(Object.keys(ipMap).length ? { ipMap: { ...ipMap } } : {}) })

  return {
    async start(o) {
      if (!options.wasmURL) throw new Error("createTailscaleConnectClient needs `wasmURL` (where main.wasm is served).")
      const [mod, roots] = await Promise.all([
        (
          options.load ?? (() => import("@agent-wasm/tailscale-connect") as unknown as Promise<TailscaleConnectModule>)
        )(),
        typeof options.caCertificates === "string"
          ? options.caCertificates
          : options.caCertificates
            ? options.caCertificates()
            : import("./tailscale-roots").then((m) => m.default),
      ])
      // After the module: it defines the `Go` class and its stub `fs`, which this extends.
      installTailscaleRoots(roots)
      const state = new Map(Object.entries(o.state ?? {}))
      if (o.exitNodeId) exitNodeId = o.exitNodeId
      releaseSockets = trackSockets()
      const instance = await mod.createIPN({
        authKey: o.authKey ?? "",
        controlURL: o.controlUrl,
        hostname: o.hostname,
        wasmURL: options.wasmURL,
        stateStorage: {
          getState: (id) => state.get(id) ?? "",
          setState: (id, value) => {
            state.set(id, options.acceptDns !== false ? keepCorpDns(id, value) : value)
            o.onState(Object.fromEntries(state))
          },
        },
        panicHandler: (error) => {
          releaseSockets()
          o.onEvent({ error })
        },
        ...dnsSettings(options.acceptDns !== false),
        ...(exitNodeId ? exitNodeSettings(exitNodeId) : {}),
      })
      if (disposed) return
      ipn = instance
      instance.run({
        notifyState: (s) => o.onEvent({ state: s }),
        notifyNetMap: (text) => {
          try {
            const netMap = JSON.parse(text) as TailscaleNetMap
            // A build that never reports the choice (the Go side of the bundled one does not) must not have it cleared by every
            // net map: only a map that says something about it (even null) settles it, as the session does.
            if (netMap.selectedExitNodeId !== undefined) exitNodeId = netMap.selectedExitNodeId
            o.onEvent({ netMap })
          } catch {
            o.onEvent({ netMap: null })
          }
        },
        notifyBrowseToURL: (url) => o.onEvent({ loginUrl: url }),
        notifyPanicRecover: (error) => {
          releaseSockets()
          o.onEvent({ error })
        },
      })
    },
    login() {
      ipn?.login()
    },
    logout() {
      ipn?.logout()
    },
    async setExitNode(id) {
      if (!ipn) throw new Error("The Tailscale client is not running.")
      if (!ipn.configure) throw new Error("This build of the Tailscale client cannot change its exit node.")
      exitNodeId = id
      await applyConfig()
      addresses.clear()
    },
    async fetch(req: TailscaleRequest): Promise<TailscaleResponse> {
      if (!ipn) throw new Error("The Tailscale client is not running.")
      // Through an exit node, redirects are followed here rather than in the client (as almostnode does): a redirect to another
      // public name (google.com → www.google.com) needs that name looked up and dialled the same way, which the client cannot do.
      if (exitNodeId === null || (req.redirect ?? "follow") !== "follow" || !isPublicName(new URL(req.url).hostname))
        return fetchOnce(req)
      let current: TailscaleRequest = { ...req, redirect: "manual" }
      for (let hop = 0; ; hop++) {
        const res = await fetchOnce(current)
        const location = REDIRECT_STATUSES.has(res.status)
          ? res.headers.find(([k]) => k.toLowerCase() === "location")?.[1]
          : undefined
        if (!location) return res
        if (hop >= MAX_REDIRECTS) throw new Error(`${req.url} redirected more than ${MAX_REDIRECTS} times.`)
        const next = new URL(location, current.url)
        if (next.protocol !== "http:" && next.protocol !== "https:") return res
        // 303, and 301/302 after a POST, continue as a GET without a body (the Fetch standard's rule).
        const toGet =
          res.status === 303
            ? (current.method ?? "GET").toUpperCase() !== "HEAD"
            : (res.status === 301 || res.status === 302) && (current.method ?? "GET").toUpperCase() === "POST"
        current = toGet
          ? {
              ...current,
              url: next.href,
              method: "GET",
              body: null,
              headers: current.headers?.filter(([k]) => !/^content-/i.test(k)),
            }
          : { ...current, url: next.href }
      }
    },
    dispose() {
      // The Go runtime has no shutdown: a disposed instance stops being used and is collected with the page.
      disposed = true
      ipn = null
      releaseSockets()
    },
  }

  async function fetchOnce(req: TailscaleRequest): Promise<TailscaleResponse> {
    if (!ipn) throw new Error("The Tailscale client is not running.")
    const method = (req.method ?? "GET").toUpperCase()
    const url = new URL(req.url)
    // Through an exit node a public name needs an address: look it up, tell the client (`ipMap`) and fetch the name as asked —
    // the way almostnode does. If the client ignores the map, dial the address with the name kept as the Host header and the
    // TLS server name instead.
    const viaExit = exitNodeId !== null && isPublicName(url.hostname)
    const simple =
      !viaExit && method === "GET" && !req.body && !req.headers?.length && (req.redirect ?? "follow") === "follow"
    const headers = Object.fromEntries(req.headers ?? [])
    const structured = (target: string, extra: Record<string, unknown> = {}) => ({
      url: target,
      method,
      headers,
      bodyBase64: req.body ? bytesToBase64(req.body) : undefined,
      redirect: req.redirect,
      ...extra,
    })
    let res: Awaited<ReturnType<TailscaleIpn["fetch"]>>
    if (viaExit) {
      const ip = await resolvePublic(url.hostname)
      const reason = (e: unknown) =>
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : ((e as { message?: string } | null)?.message ?? String(e))
      // One literal address: the client dials it directly, never racing several (see `exitNodeDial`).
      const byAddress = () => {
        const direct = new URL(req.url)
        direct.hostname = ip
        const withHost = { ...headers }
        for (const name of Object.keys(withHost)) if (name.toLowerCase() === "host") delete withHost[name]
        withHost.Host = url.host
        return ipn!.fetch({
          ...structured(direct.href),
          headers: withHost,
          ...(url.protocol === "https:" ? { tlsServerName: url.hostname } : {}),
        })
      }
      if (options.exitNodeDial === "name") {
        if (ipMap[url.hostname] !== ip) {
          ipMap[url.hostname] = ip
          await applyConfig()
        }
        try {
          res = await ipn.fetch(structured(req.url))
        } catch (primary) {
          try {
            res = await byAddress()
          } catch (fallback) {
            throw new Error(
              `${url.hostname} (${ip}) could not be fetched through the exit node. Fetching the name: ${reason(primary)}. Fetching the address: ${reason(fallback)}.`,
            )
          }
        }
      } else {
        try {
          res = await byAddress()
        } catch (e) {
          throw new Error(`${url.hostname} (${ip}) could not be fetched through the exit node: ${reason(e)}.`)
        }
      }
    } else {
      // The minimal build only takes a URL string; the structured form needs a build that has it (almostnode's does).
      res = await ipn.fetch(simple ? req.url : structured(req.url))
    }
    const body =
      res.bodyBase64 !== undefined
        ? base64ToBytes(res.bodyBase64)
        : res.text
          ? new TextEncoder().encode(await res.text())
          : null
    return {
      url: viaExit ? req.url : (res.url ?? req.url),
      status: res.status,
      statusText: res.statusText ?? "",
      headers: Object.entries(res.headers ?? {}),
      body,
    }
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
