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
  const { loadBrowserRenderLib } = await import("@opentui/core/browser")
  const base = new URL(import.meta.env.BASE_URL + "opentui/", window.location.origin)
  await loadBrowserRenderLib({
    wasm: new URL("opentui.wasm", base),
    assets: {
      treeSitterWasm: new URL("tree-sitter.wasm", base).href,
      treeSitterWorker: new URL("parser.worker.browser.js", base).href,
      treeSitterAssetBase: base.href,
    },
  })
  await import("./shims/bun.browser")
  await check("Browser Buffer round-trips OAuth base64url bytes", async () => {
    const value = "OpenCode 😺 /+"
    const encoded = Buffer.from(value).toString("base64url")
    if (/[+/=]/.test(encoded) || Buffer.from(encoded, "base64url").toString() !== value)
      throw new Error("base64url codec failed")
  })
  process.cwd = () => "/workspace"
  const { seedDemoProject } = await import("./seed-project")
  seedDemoProject()
  const { createBrowserBackend } = await import("./backend")
  const backend = await check("Upstream v2 server and WASM migrations", () =>
    createBrowserBackend({
      onStage: (stage) => {
        status.textContent = stage
      },
      onLog: (message) => {
        if (message.includes('"level":"INFO"')) return
        const item = document.createElement("li")
        item.textContent = "Server diagnostic: " + message
        results.append(item)
      },
    }),
  )
  if (!backend) throw new Error("Backend startup failed")
  const { OpenCode } = await import("@opencode/client")
  const api = OpenCode.make({
    baseUrl: backend.url,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await backend.fetch(input, init)
        if (!response.ok) {
          const item = document.createElement("li")
          item.textContent = `HTTP ${response.status}: ${await response.clone().text()}`
          results.append(item)
        }
        return response
      },
      { preconnect: () => {} },
    ),
  })
  const location = { directory: "/workspace" }
  try {
    await check("Server reports v2.2.4", async () => {
      const info = await api.server.info()
      if (info.version !== "2.2.4") throw new Error("Wrong version: " + info.version)
    })
    await check("Lists the real virtual workspace", async () => {
      const result = await api.file.list({ location })
      if (!JSON.stringify(result.data).includes("package.json")) throw new Error("Workspace files missing")
    })
    await check("Reads actual source bytes", async () => {
      const bytes = await api.file.read({ location, path: "src/index.ts" })
      if (!new TextDecoder().decode(bytes).includes("formatDate")) throw new Error("Wrong file contents")
    })
    await check("Loads bundled current models without background CORS fetches", async () => {
      const models = await api.model.list({ location })
      if (!models.data.length) throw new Error("No models available")
    })
    await check("Offers device auth without a native loopback listener", async () => {
      const result = await api.integration.get({ location, integrationID: "openai" })
      const methods = JSON.stringify(result.data)
      if (!methods.includes("chatgpt-headless")) throw new Error("Device auth missing")
      if (methods.includes("chatgpt-browser")) throw new Error("Unsupported loopback auth offered")
    })
    await check("Creates and reads a real v2 session", async () => {
      const session = await api.session.create({ location, title: "WASM v2 verification" })
      const restored = await api.session.get({ sessionID: session.id })
      if (restored.title !== "WASM v2 verification") throw new Error("Session was not stored")
    })
    await check("Submitting offline finishes with a connection error instead of retrying", async () => {
      const models = await api.model.list({ location })
      const model = models.data.find(
        (model) => model.providerID === "openai" && model.enabled && model.id.includes("gpt-6.1"),
      )
      if (!model) throw new Error("Expected the current OpenAI model catalog")
      const session = await api.session.create({ location, model: { providerID: model.providerID, id: model.id } })
      const signal = AbortSignal.timeout(10000)
      await api.session.prompt({ sessionID: session.id, text: "Browser offline submission verification" }, { signal })
      await api.experimental.session.wait({ sessionID: session.id }, { signal })
      const result = await api.session.get({ sessionID: session.id })
      if (result.outcome !== "failed") throw new Error("Expected the turn to stop while offline")
      const messages = await api.message.list({ sessionID: session.id })
      if (!JSON.stringify(messages).includes("Choose Tailscale")) throw new Error("Missing actionable connection error")
    })
    await check("Keeps OAuth database memory-only", async () => {
      if (backend.storage !== "memory") throw new Error("Standalone credentials would persist")
    })
  } finally {
    await backend.dispose()
  }
  document.body.dataset.state = failed ? "fail" : "pass"
  status.textContent = `${passed} passed; ${failed} failed`
}

run().catch((error) => {
  document.body.dataset.state = "fail"
  status.textContent = errorDetails(error)
})
