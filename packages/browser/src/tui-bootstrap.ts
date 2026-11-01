import "@xterm/xterm/css/xterm.css"
import "./shims/bun.browser"

import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import {
  createBrowserRenderer,
  loadBrowserRenderLib,
  type BrowserTerminalHost,
  type BrowserTerminalKey,
} from "@opentui/core/browser"
import type { CliRenderer } from "@opentui/core"
import type { Args } from "../../tui/src/context/args"
import { registerApiFetch } from "./api-fetch"
import { withProcessBridgeScope, type BrowserProcessBridge } from "./shims/child-process.browser"
import {
  withWorkspaceBridgeScope,
  getWorkspaceRoot,
  setWorkspaceRoot,
  registerWorkspaceBridgeForRoot,
  unregisterWorkspaceBridgeForRoot,
  type BrowserWorkspaceBridge,
} from "./shims/fs.browser"
import { registerProcessBridgeForRoot, unregisterProcessBridgeForRoot } from "./shims/child-process.browser"
import type { BrowserMcpServer } from "./host-mcp"

declare const OPENCODE_VERSION: string

type ThemeMode = "dark" | "light"

declare global {
  interface Window {
    __OPENCODE_BROWSER_TUI__?: OpenCodeTuiSession & { host: BrowserTerminalHost }
    __OPENCODE_BROWSER_TUI_MOUNT_ID__?: number
  }
}

export interface BrowserTuiEnvironment {
  copy?: (text: string) => Promise<void> | void
  openUrl?: (url: string) => void
  setTitle?: (title: string) => void
  themeMode?: ThemeMode
}

export interface MountOpenCodeTuiOptions {
  mcpServers?: ReadonlyArray<BrowserMcpServer>
  container: HTMLElement
  workspaceBridge?: BrowserWorkspaceBridge
  processBridge?: BrowserProcessBridge
  wasmUrl?: string | URL
  assetBaseUrl?: string | URL
  directory?: string
  args?: Args
  env?: BrowserTuiEnvironment
  /** A real OpenCode server or embedded runtime supplied by the host. */
  server?: { url: string; fetch?: typeof fetch; dispose?(): Promise<void> | void }
}

export interface OpenCodeTuiSession {
  storage: "persistent" | "memory" | "remote"
  term: Terminal
  fitAddon: FitAddon
  renderer: CliRenderer
  exited: Promise<void>
  dispose(): void
  setThemeMode(mode: ThemeMode): void
}

function getTerminalTheme(mode: ThemeMode) {
  return {
    background: mode === "light" ? "#ffffff" : "#0d1117",
    foreground: mode === "light" ? "#24292f" : "#c9d1d9",
    cursor: mode === "light" ? "#0969da" : "#58a6ff",
    selectionBackground: mode === "light" ? "#dbeafe" : "#264f78",
  }
}

function createSyntheticBrowserKey(
  event: KeyboardEvent,
  options: {
    name: BrowserTerminalKey["name"]
    sequence: string
    raw: string
    number?: boolean
  },
): BrowserTerminalKey {
  return {
    name: options.name,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    option: event.altKey,
    sequence: options.sequence,
    number: options.number ?? false,
    raw: options.raw,
    eventType: "press",
    source: "raw",
    code: event.code,
    super: false,
    hyper: false,
    capsLock: event.getModifierState("CapsLock"),
    numLock: event.getModifierState("NumLock"),
    repeated: event.repeat,
  }
}

function getSyntheticBrowserKey(event: KeyboardEvent): BrowserTerminalKey | null {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
    const sequence = event.key.length === 1 ? event.key : "C"
    return createSyntheticBrowserKey(event, {
      name: "c",
      sequence,
      raw: sequence,
    })
  }

  if (event.key === "Backspace") {
    return createSyntheticBrowserKey(event, {
      name: "backspace",
      sequence: "\x7f",
      raw: "\x7f",
    })
  }

  if (event.key === "Enter") {
    return createSyntheticBrowserKey(event, {
      name: "return",
      sequence: "\r",
      raw: "\r",
    })
  }

  return null
}

class XtermBrowserHost implements BrowserTerminalHost {
  private readonly dataHandlers = new Set<(data: string) => void>()
  private readonly keyHandlers = new Set<(key: BrowserTerminalKey) => void>()
  private readonly resizeHandlers = new Set<(size: { cols: number; rows: number }) => void>()
  private readonly focusHandlers = new Set<(focused: boolean) => void>()
  private readonly themeHandlers = new Set<(mode: ThemeMode) => void>()
  private readonly resizeObserver: ResizeObserver
  private readonly mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  private readonly disposables: Array<{ dispose(): void }> = []
  private currentThemeMode: ThemeMode
  private overrideThemeMode: ThemeMode | null
  private readonly focusInHandler: () => void
  private readonly focusOutHandler: (event: FocusEvent) => void
  private readonly keyDownHandler: (event: KeyboardEvent) => void
  private readonly themeChangeHandler: (event: MediaQueryListEvent) => void

  constructor(
    private readonly term: Terminal,
    private readonly fitAddon: FitAddon,
    private readonly surface: HTMLElement,
    private readonly env?: BrowserTuiEnvironment,
  ) {
    this.overrideThemeMode = env?.themeMode ?? null
    this.currentThemeMode = this.resolveThemeMode()

    this.disposables.push(
      this.term.onData((data) => {
        for (const handler of this.dataHandlers) {
          handler(data)
        }
      }),
    )

    this.disposables.push(
      this.term.onResize(({ cols, rows }) => {
        const size = { cols, rows }
        for (const handler of this.resizeHandlers) {
          handler(size)
        }
      }),
    )

    this.focusInHandler = () => {
      for (const handler of this.focusHandlers) {
        handler(true)
      }
    }

    this.focusOutHandler = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && this.surface.contains(event.relatedTarget)) {
        return
      }

      for (const handler of this.focusHandlers) {
        handler(false)
      }
    }

    this.keyDownHandler = (event: KeyboardEvent) => {
      if (!this.surface.contains(event.target as Node | null)) {
        return
      }

      const key = getSyntheticBrowserKey(event)
      if (key) {
        event.preventDefault()
        event.stopPropagation()

        for (const handler of this.keyHandlers) {
          handler(key)
        }
      }
    }

    this.themeChangeHandler = (event: MediaQueryListEvent) => {
      if (this.overrideThemeMode) {
        return
      }
      this.currentThemeMode = event.matches ? "dark" : "light"
      this.emitThemeModeChange()
    }

    this.surface.addEventListener("focusin", this.focusInHandler)
    this.surface.addEventListener("focusout", this.focusOutHandler)
    this.surface.addEventListener("keydown", this.keyDownHandler, true)
    this.mediaQuery.addEventListener("change", this.themeChangeHandler)

    this.resizeObserver = new ResizeObserver(() => {
      this.fitAddon.fit()
    })
    this.resizeObserver.observe(this.surface)
  }

  public fit(): void {
    this.fitAddon.fit()
  }

  public getSize(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows }
  }

  public write(data: string): void {
    this.term.write(data)
  }

  public onData(handler: (data: string) => void): () => void {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  public onResize(handler: (size: { cols: number; rows: number }) => void): () => void {
    this.resizeHandlers.add(handler)
    return () => this.resizeHandlers.delete(handler)
  }

  public onKey(handler: (key: BrowserTerminalKey) => void): () => void {
    this.keyHandlers.add(handler)
    return () => this.keyHandlers.delete(handler)
  }

  public onFocusChange(handler: (focused: boolean) => void): () => void {
    this.focusHandlers.add(handler)
    return () => this.focusHandlers.delete(handler)
  }

  public onThemeModeChange(handler: (mode: ThemeMode) => void): () => void {
    this.themeHandlers.add(handler)
    handler(this.currentThemeMode)
    return () => this.themeHandlers.delete(handler)
  }

  public setThemeMode(mode: ThemeMode | null): void {
    this.overrideThemeMode = mode
    this.currentThemeMode = this.resolveThemeMode()
    this.emitThemeModeChange()
  }

  public copy(text: string): Promise<void> {
    if (this.env?.copy) {
      return Promise.resolve(this.env.copy(text)).then(() => {})
    }
    if (!navigator.clipboard?.writeText) {
      return Promise.reject(new Error("Clipboard API unavailable"))
    }
    return navigator.clipboard.writeText(text)
  }

  public setTitle(title: string): void {
    this.env?.setTitle?.(title)
    if (!this.env?.setTitle) {
      document.title = title
    }
  }

  private resolveThemeMode(): ThemeMode {
    return this.overrideThemeMode ?? (this.mediaQuery.matches ? "dark" : "light")
  }

  private emitThemeModeChange(): void {
    for (const handler of this.themeHandlers) {
      handler(this.currentThemeMode)
    }
  }

  public destroy(): void {
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    this.resizeObserver.disconnect()
    this.surface.removeEventListener("focusin", this.focusInHandler)
    this.surface.removeEventListener("focusout", this.focusOutHandler)
    this.surface.removeEventListener("keydown", this.keyDownHandler, true)
    this.mediaQuery.removeEventListener("change", this.themeChangeHandler)
  }
}

function withScopedBridges<T>(
  workspaceBridge: BrowserWorkspaceBridge | undefined,
  processBridge: BrowserProcessBridge | undefined,
  fn: () => T,
): T {
  return withWorkspaceBridgeScope(workspaceBridge, () => withProcessBridgeScope(processBridge, fn))
}

function scopeResponseBody(response: Response, runWithScope: <T>(fn: () => T) => T): Response {
  if (!response.body) {
    return response
  }

  const reader = response.body.getReader()
  const scopedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await runWithScope(() => reader.read())
      if (result.done) {
        controller.close()
        return
      }

      controller.enqueue(result.value)
    },
    async cancel(reason) {
      await runWithScope(() => reader.cancel(reason))
    },
  })

  return new Response(scopedBody, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  })
}

function scopedFetch(
  fetch: typeof globalThis.fetch,
  workspace: BrowserWorkspaceBridge | undefined,
  process: BrowserProcessBridge | undefined,
): typeof globalThis.fetch {
  const scope = <T>(fn: () => T) => withScopedBridges(workspace, process, fn)
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await scope(() => fetch(input, init))
      return scopeResponseBody(response, scope)
    },
    { preconnect: fetch.preconnect?.bind(fetch) ?? (() => {}) },
  )
}

export async function mountOpenCodeTui(options: MountOpenCodeTuiOptions): Promise<OpenCodeTuiSession> {
  const directory = options.directory ?? getWorkspaceRoot()
  const cleanups: (() => void)[] = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const cleanup of cleanups.toReversed()) {
      try {
        cleanup()
      } catch (error) {
        console.error("[opencode-browser] cleanup failed", error)
      }
    }
    cleanups.length = 0
  }
  try {
    setWorkspaceRoot(directory)
    if (options.workspaceBridge) {
      registerWorkspaceBridgeForRoot(directory, options.workspaceBridge)
      cleanups.push(() => unregisterWorkspaceBridgeForRoot(directory, options.workspaceBridge!))
    }
    if (options.processBridge) {
      registerProcessBridgeForRoot(directory, options.processBridge)
      cleanups.push(() => unregisterProcessBridgeForRoot(directory, options.processBridge!))
    }

    const base = new URL(options.assetBaseUrl ?? "../opentui/", import.meta.url)
    await loadBrowserRenderLib({
      wasm: options.wasmUrl ?? new URL("opentui.wasm", base),
      assets: {
        treeSitterWasm: new URL("tree-sitter.wasm", base).href,
        treeSitterWorker: new URL("parser.worker.browser.js", base).href,
        treeSitterAssetBase: base.href,
      },
    })
    process.cwd = () => directory

    // The native FFI backend is selected during module evaluation. Load the
    // production TUI only after installing the WebAssembly backend above.
    const [{ run }, { Global }, { Effect, Layer }, { NodeFileSystem }] = await Promise.all([
      import("../../tui/src/app"),
      import("@opencode/util/global"),
      import("effect"),
      import("./shims/effect-platform-node.browser"),
    ])
    const backend =
      options.server ??
      (await withScopedBridges(options.workspaceBridge, options.processBridge, async () => {
        const { createBrowserBackend } = await import("./backend")
        return { ...(await createBrowserBackend({ mcpServers: options.mcpServers })), url: "http://opencode.internal" }
      }))
    cleanups.push(() => {
      void Promise.resolve(backend.dispose?.()).catch(console.error)
    })
    const fetch = scopedFetch(
      backend.fetch ?? globalThis.fetch.bind(globalThis),
      options.workspaceBridge,
      options.processBridge,
    )
    cleanups.push(registerApiFetch(backend.url, fetch))
    const mode = options.env?.themeMode ?? "dark"
    const fitAddon = new FitAddon()
    const term = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SFMono-Regular", monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 3000,
      theme: getTerminalTheme(mode),
    })
    cleanups.push(() => term.dispose())
    term.loadAddon(fitAddon)
    term.open(options.container)
    const host = new XtermBrowserHost(term, fitAddon, options.container, options.env)
    cleanups.push(() => host.destroy())
    host.onThemeModeChange((mode) => {
      term.options.theme = getTerminalTheme(mode)
      options.container.dataset.almostnodeTheme = mode
    })
    host.fit()
    term.focus()
    const renderer = await createBrowserRenderer(host, {
      screenMode: "alternate-screen",
      autoFocus: true,
      openConsoleOnError: false,
    })
    cleanups.push(() => renderer.destroy())
    cleanups.push(() => {
      if (window.__OPENCODE_BROWSER_TUI__?.renderer === renderer) delete window.__OPENCODE_BROWSER_TUI__
    })
    let config = { attention: { sound: false, notifications: false } }
    const firstFrame = Promise.withResolvers<void>()
    const exited = Effect.runPromise(
      run({
        app: { name: "opencode", version: OPENCODE_VERSION, channel: "browser" },
        server: { endpoint: { url: backend.url }, local: !options.server },
        args: options.args ?? {},
        config: {
          get: async () => structuredClone(config),
          update: async (update) => {
            const next = structuredClone(config)
            update(next)
            config = next
            return structuredClone(config)
          },
        },
        packages: {
          prepare: async () => {
            throw new Error("Installing external TUI plugins requires a host package runtime.")
          },
        },
        terminalHandoff: async () => ({ renderer, mode, complete: () => firstFrame.resolve() }),
      }).pipe(
        Effect.provide(
          Global.layerWith({
            home: "/home/browser",
            data: "/opencode/data",
            cache: "/opencode/cache",
            config: "/opencode/config",
            state: "/opencode/state",
            tmp: "/tmp",
            bin: "/opencode/bin",
            log: "/opencode/log",
            repos: "/opencode/repos",
          }).pipe(Layer.provide(NodeFileSystem.layer)),
        ),
        Effect.provide(NodeFileSystem.layer),
      ),
    ).finally(dispose)
    await Promise.race([
      firstFrame.promise,
      exited.then(() => {
        throw new Error("OpenCode closed before rendering its first frame")
      }),
    ])
    const storage: OpenCodeTuiSession["storage"] =
      "storage" in backend && (backend.storage === "persistent" || backend.storage === "memory")
        ? backend.storage
        : "remote"
    const session: OpenCodeTuiSession & { host: BrowserTerminalHost } = {
      storage,
      term,
      fitAddon,
      renderer,
      host,
      exited,
      dispose,
      setThemeMode: (mode: ThemeMode) => host.setThemeMode(mode),
    }
    window.__OPENCODE_BROWSER_TUI__ = session
    return session
  } catch (error) {
    dispose()
    throw error
  }
}
