import "./shims/disposable.browser"
import process from "process"
import { browserFetch } from "./browser-fetch"
import { loadBrowserRenderLib } from "@opentui/core/browser"
import xtermStyles from "@xterm/xterm/css/xterm.css?inline"
import connectionStyles from "./styles/connection.css?inline"
import type { MountOpenCodeTuiOptions, OpenCodeTuiSession } from "./tui-bootstrap"
import type { BrowserConnectionStore } from "./connection-state"

export type { BrowserCredentialStore } from "./credentials"
export type { BrowserConnectionStore } from "./connection-state"
export const capabilities = { credentialStore: 1, connectionStore: 1, hostMcp: 1 } as const

export type { BrowserWorkspaceBridge } from "./shims/fs.browser"
export type { BrowserProcessBridge } from "./shims/child-process.browser"
export type { BrowserMcpServer } from "./host-mcp"

export interface MountOptions extends Omit<MountOpenCodeTuiOptions, "env"> {
  connectionContainer: HTMLElement
  themeMode?: "light" | "dark"
  connectionStore?: BrowserConnectionStore
}

declare const OPENCODE_VERSION: string
export const version = OPENCODE_VERSION

// The upstream TUI and renderer install document-wide terminal state. Keep one
// active embedded session per document; Stop releases it before another starts.
let active = false

/** Stable browser module for BL UI and other host runtimes. All assets are relative to this module. */
export async function mount(options: MountOptions): Promise<OpenCodeTuiSession> {
  if (options.credentialStore && options.server)
    throw new Error("The encrypted credential bridge requires the embedded browser server.")
  if (options.credentialStore && options.credentialStore.version !== 1)
    throw new Error("Unsupported encrypted credential bridge version.")
  if (options.connectionStore && options.server)
    throw new Error("The encrypted connection bridge requires the embedded browser server.")
  if (options.connectionStore && options.connectionStore.version !== 1)
    throw new Error("Unsupported encrypted connection bridge version.")
  if (options.mcpServers?.length && options.server)
    throw new Error("Host MCP servers require the embedded browser backend.")
  if (options.mcpServers?.some((server) => server.version !== "1"))
    throw new Error("Unsupported host MCP bridge version.")
  if (new Set(options.mcpServers?.map((server) => server.name)).size !== (options.mcpServers?.length ?? 0))
    throw new Error("Host MCP server names must be unique.")
  if (active) throw new Error("An OpenCode runtime is already active in this page. Stop it before starting another.")
  active = true
  // AlmostNode may install only { env, cwd }. OpenTUI needs the full browser
  // process shim (streams and EventEmitter), which also works for that host.
  if (typeof globalThis.process?.on !== "function") globalThis.process = process
  const style = document.createElement("style")
  style.textContent = xtermStyles + "\n" + connectionStyles
  document.head.append(style)
  let session: OpenCodeTuiSession | undefined
  let connection: (() => void) | undefined
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    session?.dispose()
    connection?.()
    options.container.replaceChildren()
    style.remove()
    active = false
  }
  try {
    const base = new URL("opentui/", import.meta.url)
    await loadBrowserRenderLib({
      wasm: await browserFetch(new URL("opentui.wasm", base)),
      assets: {
        treeSitterWasm: new URL("tree-sitter.wasm", base).href,
        treeSitterWorker: new URL("parser.worker.browser.js", base).href,
        treeSitterAssetBase: base.href,
      },
    })
    const { mountOpenCodeTui } = await import("./tui-bootstrap")
    const { mountConnectionDialog } = await import("./connection-dialog")
    connection = mountConnectionDialog({
      container: options.connectionContainer,
      autoOpen: false,
      keychain: Boolean(options.credentialStore),
      connectionStore: options.connectionStore,
    })
    session = await mountOpenCodeTui({ ...options, assetBaseUrl: base, env: { themeMode: options.themeMode } })
    return { ...session, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
