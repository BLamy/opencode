import "@xterm/xterm/css/xterm.css"
import "./shims/bun.browser"

import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import {
  createBrowserRenderer,
  loadBrowserRenderLib,
  type BrowserRenderer,
  type BrowserTerminalHost,
  type BrowserTerminalKey,
} from "@opentui/core/browser"
import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { TuiConfig } from "../../opencode/src/config/tui"
import { tui } from "../../opencode/src/cli/cmd/tui/app"
import type { EventSource } from "../../opencode/src/cli/cmd/tui/context/sdk"
import type { Args } from "../../opencode/src/cli/cmd/tui/context/args"
import { Instance } from "../../opencode/src/project/instance"
import { initBrowserDB, startAutoPersist } from "./shims/db.browser"
import {
  withProcessBridgeScope,
  type BrowserProcessBridge,
} from "./shims/child-process.browser"
import {
  withWorkspaceBridgeScope,
  type BrowserWorkspaceBridge,
} from "./shims/fs.browser"
import { Server } from "../../opencode/src/server/server"

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
  container: HTMLElement
  workspaceBridge: BrowserWorkspaceBridge
  processBridge?: BrowserProcessBridge
  wasmUrl?: string | URL
  directory?: string
  args?: Args
  env?: BrowserTuiEnvironment
}

export interface OpenCodeTuiSession {
  term: Terminal
  fitAddon: FitAddon
  renderer: BrowserRenderer
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
  workspaceBridge: BrowserWorkspaceBridge,
  processBridge: BrowserProcessBridge | undefined,
  fn: () => T,
): T {
  return withWorkspaceBridgeScope(workspaceBridge, () =>
    withProcessBridgeScope(processBridge, fn),
  )
}

function scopeResponseBody(
  response: Response,
  runWithScope: <T>(fn: () => T) => T,
): Response {
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

function createInternalFetch(
  workspaceBridge: BrowserWorkspaceBridge,
  processBridge?: BrowserProcessBridge,
): typeof fetch {
  const runWithScope = <T>(fn: () => T) => withScopedBridges(workspaceBridge, processBridge, fn)

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const response = await runWithScope(() => Server.Default().fetch(request))
    return scopeResponseBody(response, runWithScope)
  }) as typeof fetch
}

function createInternalEventSource(directory: string, fetchFn: typeof fetch): EventSource & { dispose(): void } {
  let workspaceID: string | undefined
  const listeners = new Set<(event: Event) => void>()
  let controller = new AbortController()
  let disposed = false

  const run = () => {
    controller.abort()
    controller = new AbortController()
    const signal = controller.signal
    const sdk = createOpencodeClient({
      baseUrl: "http://opencode.internal",
      directory,
      experimental_workspaceID: workspaceID,
      fetch: fetchFn,
      signal,
    })

    void (async () => {
      while (!disposed && !signal.aborted) {
        const response = await sdk.event.subscribe({}, { signal }).catch(() => undefined)
        if (!response) {
          if (!signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
          continue
        }

        try {
          for await (const event of response.stream) {
            if (signal.aborted || disposed) break
            for (const listener of listeners) {
              listener(event)
            }
          }
        } catch {}

        if (!signal.aborted && !disposed) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    })()
  }

  run()

  return {
    on(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    setWorkspace(nextWorkspaceID) {
      workspaceID = nextWorkspaceID
      run()
    },
    dispose() {
      disposed = true
      controller.abort()
      listeners.clear()
    },
  }
}

export async function mountOpenCodeTui(options: MountOpenCodeTuiOptions): Promise<OpenCodeTuiSession> {
  const debugSession = new URLSearchParams(window.location.search).has("debugsession")
  const mountId = (window.__OPENCODE_BROWSER_TUI_MOUNT_ID__ ?? 0) + 1
  window.__OPENCODE_BROWSER_TUI_MOUNT_ID__ = mountId
  const directory = options.directory ?? "/workspace"

  await initBrowserDB()
  startAutoPersist()
  await loadBrowserRenderLib(options.wasmUrl ? { wasmUrl: options.wasmUrl } : {})

  const initialThemeMode = options.env?.themeMode ?? "dark"
  const fitAddon = new FitAddon()
  const term = new Terminal({
    allowTransparency: true,
    convertEol: false,
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 1.18,
    scrollback: 3000,
    theme: getTerminalTheme(initialThemeMode),
  })

  term.loadAddon(fitAddon)
  term.open(options.container)

  const host = new XtermBrowserHost(term, fitAddon, options.container, options.env)
  const applyThemeMode = (mode: ThemeMode) => {
    term.options.theme = getTerminalTheme(mode)
    options.container.dataset.almostnodeTheme = mode
  }
  host.onThemeModeChange((mode) => {
    applyThemeMode(mode)
  })
  applyThemeMode(initialThemeMode)
  host.fit()
  term.focus()

  const renderer = await createBrowserRenderer(host, {
    useAlternateScreen: true,
    autoFocus: true,
    onDestroy: () => host.destroy(),
  })

  const fetchFn = createInternalFetch(options.workspaceBridge, options.processBridge)
  const events = createInternalEventSource(directory, fetchFn)
  const config = await withScopedBridges(options.workspaceBridge, options.processBridge, () =>
    Instance.provide({
      directory,
      fn: () => TuiConfig.get(),
    }),
  )

  let disposed = false
  let session:
    | (OpenCodeTuiSession & { host: BrowserTerminalHost; disposed?: boolean; debugSession?: boolean })
    | undefined
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (!debugSession && window.__OPENCODE_BROWSER_TUI__?.renderer === renderer) {
      delete window.__OPENCODE_BROWSER_TUI__
    }
    if (session) {
      session.disposed = true
    }
    events.dispose()
    renderer.destroy()
    host.destroy()
    term.dispose()
  }

  const exited = tui({
    url: "http://opencode.internal",
    directory,
    fetch: fetchFn,
    events,
    args: options.args ?? {},
    config,
    renderer,
  }).finally(() => {
    dispose()
  })

  session = {
    term,
    fitAddon,
    renderer,
    host,
    exited,
    dispose,
    setThemeMode(mode) {
      host.setThemeMode(mode)
    },
    debugSession,
  }

  if (window.__OPENCODE_BROWSER_TUI_MOUNT_ID__ === mountId) {
    window.__OPENCODE_BROWSER_TUI__ = session
  }

  return session
}
