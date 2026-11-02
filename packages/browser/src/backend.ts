import { Credential } from "@opencode/core/credential"
import { browserCredentialNode, type BrowserCredentialStore } from "./credentials"
import { Database } from "@opencode/core/database/database"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { filesystem, httpClient, path } from "@opencode/util/effect/app-node-platform"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { RipgrepBinary } from "@opencode/core/ripgrep/binary"
import { ServerFetch } from "@opencode/server/fetch"
import { Cause, Context, Effect, ErrorReporter, Exit, FileSystem, Layer, Logger, Path, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { initBrowserDB } from "./shims/db.browser"
import { NodeChildProcessSpawner, NodeFileSystem } from "./shims/effect-platform-node.browser"
import { BrowserSqlite } from "./sqlite"
import { fetch } from "./provider-network"
import { Mcp } from "@opencode/core/mcp/index"
import { hostMcpNode, type BrowserMcpServer } from "./host-mcp"

export const browserPaths = {
  home: "/home/browser",
  data: "/opencode/data",
  cache: "/opencode/cache",
  config: "/opencode/config",
  state: "/opencode/state",
  tmp: "/tmp",
  bin: "/opencode/bin",
  log: "/opencode/log",
  repos: "/opencode/repos",
}

export interface BrowserBackendOptions {
  readonly credentialStore?: BrowserCredentialStore
  readonly mcpServers?: ReadonlyArray<BrowserMcpServer>
  readonly database?: BrowserSqlite.Database
  readonly filesystem?: Layer.Layer<FileSystem.FileSystem>
  readonly path?: Layer.Layer<Path.Path>
  readonly spawner?: Layer.Layer<ChildProcessSpawner>
  readonly replacements?: LayerNode.Replacements
  readonly onLog?: (message: string) => void
  readonly onStage?: (stage: "Opening WASM SQLite" | "Building HTTP routes" | "Starting HTTP services") => void
}

/** Run the upstream v2 HTTP application over the real WASM SQLite and browser VFS. */
export async function createBrowserBackend(options: BrowserBackendOptions = {}) {
  options.onStage?.("Opening WASM SQLite")
  const database = options.database ?? (await initBrowserDB())
  const scope = await Effect.runPromise(Scope.make())
  const replacements: LayerNode.Replacements = [
    Database.node.replace(Database.configuredClient(BrowserSqlite.layer(database))),
    Global.node.replace(Global.layerWith(browserPaths)),
    filesystem.replace(options.filesystem ?? NodeFileSystem.layer),
    path.replace(options.path ?? Path.layer),
    httpClient.replace(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))),
    CrossSpawnSpawner.node.replace(options.spawner ?? NodeChildProcessSpawner.layer),
    RipgrepBinary.node.replace(Layer.succeed(RipgrepBinary.Service, { filepath: Effect.succeed("rg") })),
    ConfigPluginSource.node.replace(ConfigPluginSource.empty),
    ...(options.credentialStore ? [Credential.node.replace(browserCredentialNode(options.credentialStore))] : []),
    ...(options.mcpServers?.length ? [Mcp.node.replace(hostMcpNode(options.mcpServers))] : []),
    ...(options.replacements ?? []),
  ]
  const logs = options.onLog
    ? Context.make(
        Logger.CurrentLoggers,
        new Set([
          Logger.make((entry) =>
            options.onLog?.(
              JSON.stringify(Logger.formatStructured.log(entry), (_, value) =>
                value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
              ),
            ),
          ),
        ]),
      ).pipe(
        Context.add(
          ErrorReporter.CurrentErrorReporters,
          new Set([
            {
              [ErrorReporter.TypeId]: ErrorReporter.TypeId,
              report: ({ cause }: { cause: Cause.Cause<unknown> }) => options.onLog?.(Cause.pretty(cause)),
            },
          ]),
        ),
      )
    : undefined
  let disposed = false
  try {
    options.onStage?.("Building HTTP routes")
    const handler = await Effect.runPromise(
      ServerFetch.make(
        {
          app: { name: "opencode", version: "2.2.4", channel: "browser" },
          models: { fetch: false },
          fs: { filewatcher: false, fff: false },
          config: {
            directory: browserPaths.config,
            project: false,
            claude: false,
            content: JSON.stringify({ providers: { openai: { settings: { transport: "http", encoding: "none" } } } }),
          },
        },
        { overrides: replacements },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Scope.provide(scope)),
    )
    options.onStage?.("Starting HTTP services")
    const backendFetch: typeof globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        if (disposed) return Promise.reject(new Error("Browser backend has been disposed"))
        return handler(new Request(input, init), logs)
      },
      { preconnect: () => {} },
    )
    return {
      url: "http://opencode.internal",
      fetch: backendFetch,
      // v2 credentials share SQLite with sessions. Never persist this database
      // to IndexedDB; the v1 database is intentionally left untouched.
      storage: "memory" as const,
      async dispose() {
        if (disposed) return
        disposed = true
        await Effect.runPromise(Scope.close(scope, Exit.void))
      },
    }
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }
}
