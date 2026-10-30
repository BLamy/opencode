const status = document.querySelector<HTMLElement>("#status")!
const results = document.querySelector<HTMLOListElement>("#results")!
let passed = 0
let failed = 0

function errorDetails(error: unknown, depth = 0): string {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  if (depth >= 4 || !error || typeof error !== "object" || !("cause" in error) || !error.cause) return message
  const cause = errorDetails(error.cause, depth + 1)
  return message.includes(cause) ? message : `${message}\nCaused by: ${cause}`
}

async function check<T>(name: string, test: () => Promise<T>) {
  status.textContent = name
  const item = document.createElement("li")
  item.textContent = `${name}: running`
  results.append(item)
  try {
    const value = await test()
    passed += 1
    item.dataset.state = "pass"
    item.textContent = `${name}: passed`
    return value
  } catch (error) {
    failed += 1
    item.dataset.state = "fail"
    item.textContent = `${name}: ${errorDetails(error)}`
    return undefined
  }
}

async function run() {
  status.textContent = "Importing browser render runtime module…"
  const { loadBrowserRenderLib } = await import("@opentui/core/browser")
  const base = new URL(import.meta.env.BASE_URL + "opentui/", window.location.origin)
  status.textContent = "Initializing WebAssembly and browser process services…"
  await loadBrowserRenderLib({
    wasm: new URL("opentui.wasm", base),
    assets: {
      treeSitterWasm: new URL("tree-sitter.wasm", base).href,
      treeSitterWorker: new URL("parser.worker.browser.js", base).href,
      treeSitterAssetBase: base.href,
    },
  })
  status.textContent = "Importing Bun compatibility services…"
  await import("./shims/bun.browser")
  process.cwd = () => "/workspace"
  status.textContent = "Seeding the virtual workspace…"
  const { seedDemoProject } = await import("./seed-project")
  seedDemoProject()
  status.textContent = "Importing the stable OpenCode HTTP service graph…"
  const { createBrowserBackend } = await import("./backend")
  const backend = await check("Real server startup and Core migrations", () =>
    createBrowserBackend({
      persistIntervalMs: 0,
      onStage: (stage) => {
        status.textContent = stage
      },
    }),
  )
  if (!backend) return
  const request = async (path: string, init?: RequestInit) => {
    const response = await backend.fetch(new URL(path, "http://opencode.internal"), {
      ...init,
      signal: AbortSignal.timeout(20000),
      headers: { "x-opencode-directory": "/workspace", ...init?.headers },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 1200)}`)
    return response
  }
  const json = async (path: string, init?: RequestInit): Promise<unknown> => (await request(path, init)).json()
  let sessionID: string | undefined
  try {
    await check("GET /global/health", async () => {
      const body = await json("/global/health")
      if (!body || typeof body !== "object" || !("healthy" in body) || body.healthy !== true)
        throw new Error("Server did not report healthy")
    })
    await check("GET /api/health", async () => {
      const body = await json("/api/health")
      if (!body || typeof body !== "object" || !("healthy" in body) || body.healthy !== true)
        throw new Error("Core API did not report healthy")
    })
    await check("GET /config", async () => {
      const body = await json("/config")
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected configuration object")
    })
    await check("GET /agent", async () => {
      if (!Array.isArray(await json("/agent"))) throw new Error("Expected real agent list")
    })
    await check("GET /provider", async () => {
      const body = await json("/provider")
      if (!body || typeof body !== "object" || !("all" in body) || !Array.isArray(body.all))
        throw new Error("Expected provider catalog")
    })
    await check("POST /session and GET /session persist the same row", async () => {
      const body = await json("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Browser backend verification" }),
      })
      if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
        throw new Error("Session creation did not return an ID")
      sessionID = body.id
      const sessions = await json("/session")
      if (!Array.isArray(sessions) || !sessions.some((item) => item?.id === sessionID))
        throw new Error("Created session was not returned from SQLite")
    })
    await check("GET /api/session reads shared Core storage", async () => {
      const body = await json("/api/session?directory=%2Fworkspace")
      if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
        throw new Error("Expected Core session list")
      if (sessionID && !body.data.some((item) => item?.id === sessionID))
        throw new Error("Legacy and Core APIs did not read the same session")
    })
    await check("GET /api/fs/list reads the real virtual workspace", async () => {
      const body = await json("/api/fs/list?location%5Bdirectory%5D=%2Fworkspace")
      if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data) || !body.data.length)
        throw new Error("Expected seeded virtual workspace entries")
    })
    await check("GET /api/fs/read serves the actual seeded file", async () => {
      const response = await request("/api/fs/read/package.json?location%5Bdirectory%5D=%2Fworkspace")
      const body = await response.json()
      if (body.name !== "demo-project") throw new Error("Expected the real VFS package.json")
    })
    await check("GET /global/event streams a real connection event", async () => {
      const response = await request("/global/event")
      if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Expected event stream")
      const reader = response.body?.getReader()
      if (!reader) throw new Error("Event stream has no body")
      try {
        const part = await reader.read()
        if (part.done || !new TextDecoder().decode(part.value).includes("server.connected"))
          throw new Error("No server.connected event received")
      } finally {
        await reader.cancel()
      }
    })
  } finally {
    if (sessionID)
      await check("DELETE verification session", async () => {
        await request(`/session/${sessionID}`, { method: "DELETE" })
      })
    await backend.dispose()
  }
}

run()
  .catch((error: unknown) => {
    failed += 1
    const item = document.createElement("li")
    item.dataset.state = "fail"
    item.textContent = errorDetails(error)
    results.append(item)
  })
  .finally(() => {
    document.body.dataset.state = failed ? "fail" : "pass"
    status.textContent = `${passed} passed, ${failed} failed`
  })
