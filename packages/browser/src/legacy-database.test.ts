import { afterEach, beforeAll, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { Effect, ManagedRuntime } from "effect"
import initSqlJs, { type SqlJsStatic } from "sql.js"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import fixtures from "./fixtures/legacy-migrations.json"
import { BrowserLegacyDatabase } from "./legacy-database"
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
  database.run(
    "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)",
  )
  for (const entry of fixtures) {
    database.run(entry.sql)
    database.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
      entry.hash,
      Date.UTC(2026, 9, 30),
    ])
  }
  database.run(
    "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('kept-project', '/workspace', 1, 1, '[]')",
  )
  database.run(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('kept-session', 'kept-project', 'kept', '/workspace', 'Preserved history', '1.3.0', 1, 1)",
  )
  const runtime = ManagedRuntime.make(BrowserSqlite.layer(database))
  cleanup.push(async () => {
    await runtime.dispose()
    database.close()
  })
  return { database, runtime }
}

test("compatibility hashes exactly match the nine shipped SQL files and current Core IDs", () => {
  for (const entry of fixtures) {
    let hash = 0
    for (const character of entry.sql) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
    expect(hash.toString(36)).toBe(entry.hash)
    expect(
      BrowserLegacyDatabase.legacyMigrations.some(
        (migration) => migration.hash === entry.hash && migration.id === entry.name,
      ),
    ).toBe(true)
    expect(migrations.some((migration) => migration.id === entry.name)).toBe(true)
  }
  expect(new Set(fixtures.map((entry) => entry.hash)).size).toBe(9)
})

test("backs up exact old data, repairs only metadata, and runs real current migrations preserving sessions", async () => {
  const { database, runtime } = open()
  const original = await Effect.runPromise(BrowserSqlite.snapshot(database))
  const backups: Uint8Array[] = []
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      const repaired = yield* BrowserLegacyDatabase.repair(db, async () => {
        expect(
          database.exec("PRAGMA table_info('__drizzle_migrations')")[0]?.values.some((row) => row[1] === "name"),
        ).toBe(false)
        backups.push(original)
      })
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* DatabaseMigration.apply(db)
      yield* DatabaseMigration.apply(db)
      return {
        repaired,
        sessions: yield* db.all("SELECT id, title FROM session"),
        journal: yield* db.all("SELECT id FROM migration"),
      }
    }),
  )
  expect(result.repaired).toBe(true)
  expect(result.sessions).toEqual([{ id: "kept-session", title: "Preserved history" }])
  expect(result.journal.length).toBe(migrations.length)
  expect(backups).toHaveLength(1)
  const backup = new SQL.Database(backups[0])
  expect(backup.exec("SELECT title FROM session")[0]?.values).toEqual([["Preserved history"]])
  expect(backup.exec("PRAGMA table_info('__drizzle_migrations')")[0]?.values.some((row) => row[1] === "name")).toBe(
    false,
  )
  backup.close()
})

test("unknown journal rows fail without writes, backup replacement, or marking migrations applied", async () => {
  const { database, runtime } = open()
  database.run("UPDATE __drizzle_migrations SET hash = 'unknown-hash' WHERE id = 1")
  const original = await Effect.runPromise(BrowserSqlite.snapshot(database))
  let backedUp = false
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        return yield* BrowserLegacyDatabase.repair(db, async () => {
          backedUp = true
        })
      }),
    ),
  ).rejects.toBeDefined()
  expect(backedUp).toBe(false)
  expect(await Effect.runPromise(BrowserSqlite.snapshot(database))).toEqual(original)
})

test("a failed backup leaves the legacy schema and data unchanged", async () => {
  const { database, runtime } = open()
  const original = await Effect.runPromise(BrowserSqlite.snapshot(database))
  await expect(
    runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        return yield* BrowserLegacyDatabase.repair(db, async () => {
          throw new Error("Backup storage unavailable")
        })
      }),
    ),
  ).rejects.toBeDefined()
  expect(await Effect.runPromise(BrowserSqlite.snapshot(database))).toEqual(original)
})
