import { afterEach, beforeAll, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql"
import initSqlJs, { type SqlJsStatic } from "sql.js"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { BrowserSqlite } from "./sqlite"

const require = createRequire(import.meta.url)
let SQL: SqlJsStatic
const cleanup: Array<() => Promise<void>> = []

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") })
})

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

function open() {
  const database = new SQL.Database()
  const runtime = ManagedRuntime.make(BrowserSqlite.layer(database))
  cleanup.push(async () => {
    await runtime.dispose()
    database.close()
  })
  return { database, runtime }
}

test("executes prepared statements, binary parameters, values, and safe integers", async () => {
  const { runtime } = open()
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("CREATE TABLE example (id INTEGER PRIMARY KEY, value BLOB)")
      yield* sql.unsafe("INSERT INTO example (id, value) VALUES (?, ?)", [1, new Uint8Array([0, 128, 255])])
      return {
        rows: yield* sql.unsafe("SELECT id, value FROM example"),
        values: yield* sql.unsafe("SELECT id FROM example").values,
        integers: yield* sql
          .unsafe("SELECT 9223372036854775807 AS value")
          .pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
      }
    }),
  )
  expect(result.rows).toEqual([{ id: 1, value: new Uint8Array([0, 128, 255]) }])
  expect(result.values).toEqual([[1]])
  expect(result.integers).toEqual([{ value: 9223372036854775807n }])
})

test("rolls back nested transactions without losing the outer transaction", async () => {
  const { runtime } = open()
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("CREATE TABLE example (id INTEGER PRIMARY KEY)")
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe("INSERT INTO example VALUES (1)")
          yield* sql
            .withTransaction(sql.unsafe("INSERT INTO example VALUES (2)").pipe(Effect.andThen(Effect.fail("rollback"))))
            .pipe(Effect.ignore)
          yield* sql.unsafe("INSERT INTO example VALUES (3)")
        }),
      )
      return yield* sql.unsafe("SELECT id FROM example ORDER BY id")
    }),
  )
  expect(result).toEqual([{ id: 1 }, { id: 3 }])
})

test("blocks other clients and snapshots until the owning transaction completes", async () => {
  const { database, runtime } = open()
  const other = ManagedRuntime.make(BrowserSqlite.layer(database))
  cleanup.unshift(() => other.dispose())
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("CREATE TABLE example (id INTEGER)")),
  )

  const transaction = runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe("INSERT INTO example VALUES (1)")
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            return yield* Effect.fail("rollback")
          }),
        )
        .pipe(Effect.exit)
    }),
  )
  await entered.promise
  let queried = false
  let snapshotted = false
  const query = other
    .runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("SELECT id FROM example")))
    .then((rows) => {
      queried = true
      return rows
    })
  const snapshot = Effect.runPromise(BrowserSqlite.snapshot(database)).then((bytes) => {
    snapshotted = true
    return bytes
  })
  await Bun.sleep(10)
  expect(queried).toBe(false)
  expect(snapshotted).toBe(false)
  release.resolve()
  await transaction
  expect(await query).toEqual([])
  const restored = new SQL.Database(await snapshot)
  expect(restored.exec("SELECT id FROM example")).toEqual([])
  restored.close()
})

test("runs the current Core schema and migration journal on real WASM SQLite", async () => {
  const { runtime } = open()
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      yield* DatabaseMigration.apply(db)
      return {
        tables: yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'"),
        migrations: yield* db.all<{ id: string }>("SELECT id FROM migration"),
      }
    }),
  )
  expect(result.tables.map((table) => table.name)).toContain("session")
  expect(result.tables.map((table) => table.name)).toContain("session_input")
  expect(result.tables.map((table) => table.name)).toContain("event")
  expect(result.migrations.length).toBeGreaterThan(0)
  expect(new Set(result.migrations.map((migration) => migration.id)).size).toBe(result.migrations.length)
})

test("releases statements and rolls back when an active transaction is interrupted", async () => {
  const { runtime } = open()
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("CREATE TABLE example (id INTEGER PRIMARY KEY)")
      yield* sql.unsafe("INSERT INTO example VALUES (1)")
      yield* sql.unsafe("INSERT INTO example VALUES (1)").pipe(Effect.ignore)
    }),
  )
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const transaction = runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe("INSERT INTO example VALUES (2)")
          entered.resolve()
          yield* Effect.never
        }),
      )
    }),
    { signal: controller.signal },
  )
  await entered.promise
  controller.abort()
  await expect(transaction).rejects.toBeDefined()
  const rows = await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("SELECT id FROM example")),
  )
  expect(rows).toEqual([{ id: 1 }])
})

test("keeps foreign key enforcement enabled after exporting a persistence snapshot", async () => {
  const { database, runtime } = open()
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("PRAGMA foreign_keys = ON")
      yield* sql.unsafe("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
      yield* sql.unsafe("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))")
    }),
  )
  await Effect.runPromise(BrowserSqlite.snapshot(database))
  await expect(
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe("INSERT INTO child VALUES (99)"))),
  ).rejects.toBeDefined()
})
