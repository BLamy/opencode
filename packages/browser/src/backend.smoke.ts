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
  const base = new URL("opentui/", document.baseURI)
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
  // Synthetic credentials only: exercise the real upstream credential handlers through the supported host bridge.
  let slot: unknown = []
  let unlocked = true
  const credentialStore = {
    version: 1 as const,
    unlocked: () => unlocked,
    load: async () => structuredClone(slot),
    save: async (value: unknown) => {
      slot = structuredClone(value)
    },
    subscribe: () => () => {},
  }
  const keyed = await createBrowserBackend({ credentialStore })
  const keyedApi = OpenCode.make({ baseUrl: keyed.url, fetch: keyed.fetch })
  const saved = await check("Stores synthetic sign-in through Core into the host keychain slot", () =>
    keyedApi.credential.create({
      integrationID: "openai",
      label: "Synthetic keychain test",
      value: { type: "key", key: "synthetic-browser-credential" },
    }),
  )
  await keyed.dispose()
  const restored = await createBrowserBackend({ credentialStore })
  const restoredApi = OpenCode.make({ baseUrl: restored.url, fetch: restored.fetch })
  try {
    await check("Restores the slot in a fresh browser backend", async () => {
      const entries = await restoredApi.credential.list()
      if (entries.length !== 1 || entries[0]?.id !== saved?.id) throw new Error("Saved sign-in was not restored")
    })
    await check("A locked host cannot expose a saved provider sign-in", async () => {
      unlocked = false
      if ((await restoredApi.credential.list()).length) throw new Error("A locked credential was visible")
      unlocked = true
      if ((await restoredApi.credential.list()).length !== 1) throw new Error("Unlock did not restore the slot")
    })
    await check("Logout removes the provider sign-in from the host slot", async () => {
      if (!saved) throw new Error("No synthetic sign-in was created")
      await restoredApi.credential.remove({ credentialID: saved.id })
      if ((await restoredApi.credential.list()).length) throw new Error("Logout did not remove the sign-in")
    })
    await check("Legacy device flow saves OAuth and sends bearer and account headers", async () => {
      const { setProviderConnection } = await import("./provider-network")
      const { createTailscale } = await import("./vendor/tailscale/tailscale")
      const tailnet = createTailscale()
      const snapshot = {
        ...tailnet.getSnapshot(),
        status: "connected" as const,
        exitNodeId: "synthetic-exit",
        peers: [
          {
            id: "synthetic-exit",
            name: "Synthetic exit",
            dnsName: "synthetic.test",
            addresses: ["100.64.0.1"],
            online: true,
            exitNode: true,
          },
        ],
      }
      let bearer = false
      let account = false
      let codex = false
      setProviderConnection({
        type: "tailscale",
        client: {
          getSnapshot: () => snapshot,
          fetch: async (request) => {
            const path = new URL(request.url).pathname
            const fixture =
              path === "/api/accounts/deviceauth/usercode"
                ? { device_auth_id: "synthetic-device", user_code: "SYNTHETIC", interval: "1" }
                : path === "/api/accounts/deviceauth/token"
                  ? { authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" }
                  : path === "/oauth/token"
                    ? {
                        id_token:
                          "e30." + btoa(JSON.stringify({ chatgpt_account_id: "synthetic-account" })) + ".synthetic",
                        access_token: "synthetic-oauth-access",
                        refresh_token: "synthetic-oauth-refresh",
                        expires_in: 3600,
                      }
                    : undefined
            if (fixture)
              return {
                status: 200,
                headers: [["content-type", "application/json"]],
                body: new TextEncoder().encode(JSON.stringify(fixture)),
              }
            const headers = new Headers(request.headers)
            bearer = headers.get("authorization") === "Bearer synthetic-oauth-access"
            account = headers.get("chatgpt-account-id") === "synthetic-account"
            codex = request.url.startsWith("https://chatgpt.com/backend-api/codex/")
            return {
              status: 401,
              statusText: "Synthetic transport check",
              headers: [["content-type", "application/json"]],
              body: new TextEncoder().encode(
                JSON.stringify({
                  error: { message: "Synthetic request intercepted locally", type: "synthetic_header_check" },
                }),
              ),
            }
          },
        },
      })
      try {
        const attempt = await restoredApi.integration.oauth.connect({
          location,
          integrationID: "openai",
          methodID: "chatgpt-headless",
        })
        const deadline = Date.now() + 10000
        while (true) {
          const state = await restoredApi.integration.oauth.status({
            location,
            integrationID: "openai",
            attemptID: attempt.data.attemptID,
          })
          if (state.data.status === "complete") break
          if (state.data.status !== "pending" || Date.now() > deadline)
            throw new Error("Synthetic device flow did not complete and persist")
        }
        const stored = await restoredApi.credential.list()
        if (stored.length !== 1 || stored[0]?.value.type !== "oauth")
          throw new Error("Device flow did not persist one OAuth credential")
        const models = await restoredApi.model.list({ location })
        const model = models.data.find(
          (model) => model.providerID === "openai" && model.enabled && model.id.includes("terra"),
        )
        if (!model) throw new Error("No enabled Terra model in bundled catalog")
        const session = await restoredApi.session.create({
          location,
          model: { providerID: model.providerID, id: model.id },
        })
        const signal = AbortSignal.timeout(10000)
        await restoredApi.session.prompt({ sessionID: session.id, text: "Synthetic header check" }, { signal })
        await restoredApi.experimental.session.wait({ sessionID: session.id }, { signal })
        if (!bearer || !account || !codex)
          throw new Error(`Header path failed: bearer=${bearer}, account=${account}, codex=${codex}`)
      } finally {
        setProviderConnection({ type: "offline" })
        await tailnet.dispose()
      }
    })
  } finally {
    await restored.dispose()
  }
  await check("Restores and persists the encrypted Connection choice across runtime mounts", async () => {
    const { mountConnectionDialog } = await import("./connection-dialog")
    const { getProviderConnection, onProviderConnection } = await import("./provider-network")
    let state: unknown = { v: 1, type: "proxy", session: null }
    let written: () => void = () => {}
    const saved = new Promise<void>((resolve) => {
      written = resolve
    })
    const connectionStore = {
      version: 1 as const,
      unlocked: () => true,
      load: async () => structuredClone(state),
      save: async (value: unknown) => {
        state = structuredClone(value)
        written()
      },
      subscribe: () => () => {},
    }
    const container = document.createElement("div")
    document.body.append(container)
    let unsubscribe = () => {}
    const connected = new Promise<void>((resolve) => {
      unsubscribe = onProviderConnection(() => {
        if (getProviderConnection().type === "proxy") resolve()
      })
    })
    const dispose = mountConnectionDialog({ container, autoOpen: false, connectionStore })
    try {
      await connected
      if (container.querySelector("button")?.textContent !== "Connection: Cloudflare")
        throw new Error("Saved proxy connection was not restored")
      document.querySelector<HTMLButtonElement>("#connection-offline")!.click()
      await saved
      if (
        getProviderConnection().type !== "offline" ||
        JSON.stringify(state) !== JSON.stringify({ v: 1, type: "offline", session: null })
      )
        throw new Error("Offline choice was not persisted")
    } finally {
      unsubscribe()
      dispose()
      container.remove()
    }
    if (getProviderConnection().type !== "offline") throw new Error("Disposed connection remained active")
  })
  document.body.dataset.state = failed ? "fail" : "pass"
  status.textContent = `${passed} passed; ${failed} failed`
}

run().catch((error) => {
  document.body.dataset.state = "fail"
  status.textContent = errorDetails(error)
})

export {}
