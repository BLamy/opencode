import "../../opencode/src/server/init-projectors"

import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { filesystem, path } from "@opencode-ai/core/effect/app-node-platform"
import type { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, FileSystem, Layer, Logger, Path, References } from "effect"
import { HttpRouter } from "effect/unstable/http"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { backupBrowserDBBeforeUpgrade, initBrowserDB, persistDB } from "./shims/db.browser"
import { NodeChildProcessSpawner, NodeFileSystem } from "./shims/effect-platform-node.browser"
import { BrowserSqlite } from "./sqlite"
import { BrowserLegacyDatabase } from "./legacy-database"
import { HttpApiApp } from "../../opencode/src/server/routes/instance/httpapi/server"
import { PluginServerTransport } from "../../opencode/src/plugin/server-transport"

export interface BrowserBackendOptions {
  readonly database?: BrowserSqlite.Database
  readonly filesystem?: Layer.Layer<FileSystem.FileSystem>
  readonly path?: Layer.Layer<Path.Path>
  readonly spawner?: Layer.Layer<ChildProcessSpawner>
  readonly replacements?: LayerNode.Replacements
  readonly persist?: (snapshot: Uint8Array) => Promise<void>
  readonly backup?: (snapshot: Uint8Array) => Promise<void>
  readonly persistIntervalMs?: number
  readonly onError?: (error: unknown) => void
  readonly onStage?: (
    stage:
      | "Opening WASM SQLite"
      | "Snapshotting SQLite before migration"
      | "Building HTTP routes"
      | "Starting HTTP services",
  ) => void
}

export class BrowserDatabaseUpgradeError extends Error {
  readonly code = "BROWSER_DATABASE_UPGRADE_REQUIRED"

  constructor(
    readonly originalSnapshot: Uint8Array,
    cause: unknown,
  ) {
    super(
      "Your saved browser database needs a legacy upgrade. Its stored data has been preserved. Download the database backup before opening it with a compatible OpenCode version.",
      { cause },
    )
    this.name = "BrowserDatabaseUpgradeError"
  }
}

/** Boot the current Core and Server against browser platform services. */
export async function createBrowserBackend(options: BrowserBackendOptions = {}) {
  options.onStage?.("Opening WASM SQLite")
  const database = options.database ?? (await initBrowserDB())
  options.onStage?.("Snapshotting SQLite before migration")
  const originalSnapshot = await Effect.runPromise(BrowserSqlite.snapshot(database))
  const persist = options.persist ?? (options.database ? undefined : persistDB)
  const backup = options.backup ?? (options.database ? undefined : backupBrowserDBBeforeUpgrade)
  let legacyUpgrade = false
  let disposed = false
  // Both the UI and plugin callbacks use this same handler. The closure is
  // resolved only after the router exists, avoiding a second native runtime.
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      if (disposed) return Promise.reject(new Error("Browser backend has been disposed"))
      return web.handler(new Request(input, init), HttpApiApp.context)
    },
    { preconnect: () => undefined },
  )
  const databaseLayer = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      // sql.js uses SQLite's in-memory journal. Its exported database image is
      // persisted only while the connection lease is free of transactions.
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* BrowserLegacyDatabase.repair(db, async () => {
        if (!backup) throw new Error("A backup destination is required before upgrading a legacy database")
        await backup(originalSnapshot)
        legacyUpgrade = true
      })
      yield* DatabaseMigration.apply(db)
      return { db }
    }).pipe(Effect.orDie),
  ).pipe(Layer.provide(BrowserSqlite.layer(database)))

  const replacements: LayerNode.Replacements = [
    [Database.node, databaseLayer],
    [filesystem, options.filesystem ?? NodeFileSystem.layer],
    [path, options.path ?? Path.layer],
    [CrossSpawnSpawner.node, options.spawner ?? NodeChildProcessSpawner.layer],
    [
      PluginServerTransport.node,
      Layer.succeed(PluginServerTransport.Service, {
        resolve: Effect.succeed({ url: () => new URL("http://opencode.internal"), fetch }),
      }),
    ],
    // The browser process service dispatches registered commands; it does
    // not need a downloaded native executable in the virtual filesystem.
    [RipgrepBinary.node, Layer.succeed(RipgrepBinary.Service, { filepath: Effect.succeed("rg") })],
    ...(options.replacements ?? []),
  ]
  options.onStage?.("Building HTTP routes")
  const web = HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(undefined, {
      replacements,
      observability: Logger.layer([Logger.consoleLogFmt], { mergeWithExisting: false }).pipe(
        Layer.merge(Layer.succeed(References.MinimumLogLevel, "Info")),
      ),
    }),
    { disableLogger: true },
  )

  try {
    options.onStage?.("Starting HTTP services")
    const response = await web.handler(new Request("http://opencode.internal/api/health"), HttpApiApp.context)
    if (!response.ok) throw new Error(`Browser backend failed to start (${response.status}): ${await response.text()}`)
  } catch (error) {
    await web.dispose()
    if (
      legacyUpgrade ||
      /Legacy migration timestamp|legacy browser (migration|database)|Database is not empty and has no session table/.test(
        String(error),
      )
    )
      throw new BrowserDatabaseUpgradeError(originalSnapshot, error)
    throw error
  }

  let pendingSave: Promise<void> | undefined
  const save = () => {
    if (pendingSave) return pendingSave
    const effect = persist
      ? BrowserSqlite.snapshot(database).pipe(Effect.flatMap((snapshot) => Effect.promise(() => persist(snapshot))))
      : Effect.void
    pendingSave = Effect.runPromise(effect).finally(() => {
      pendingSave = undefined
    })
    return pendingSave
  }
  const timer =
    !persist || options.persistIntervalMs === 0
      ? undefined
      : setInterval(() => {
          if (!disposed) void save().catch(options.onError ?? console.error)
        }, options.persistIntervalMs ?? 5000)

  return {
    fetch,
    async dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      await web.dispose()
      await save()
    },
  }
}
