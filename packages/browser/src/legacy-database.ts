export * as BrowserLegacyDatabase from "./legacy-database"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "@opencode-ai/core/database/migration.gen"

// Exact SQL hashes shipped by browser OpenCode 1.3.0 at
// e3a323c154dee21b60972f8bc01b2d3439d1977e. Its journal used Date.now()
// instead of migration timestamps; retain the immutable IDs for native Core.
export const legacyMigrations = [
  { id: "20260127222353_familiar_lady_ursula", hash: "x77ekk" },
  { id: "20260211171708_add_project_commands", hash: "20xcey" },
  { id: "20260213144116_wakeful_the_professor", hash: "-xeogsz" },
  { id: "20260225215848_workspace", hash: "bbmq6x" },
  { id: "20260227213759_add_session_workspace_id", hash: "djdihn" },
  { id: "20260228203230_blue_harpoon", hash: "-lhwirp" },
  { id: "20260303231226_add_workspace_fields", hash: "guiu6t" },
  { id: "20260309230000_move_org_to_state", hash: "mnhv62" },
  { id: "20260312043431_session_message_cursor", hash: "doimf" },
] as const

const names = new Set(migrations.map((migration) => migration.id))
const known = new Map(legacyMigrations.map((migration) => [migration.hash as string, migration.id as string]))
const lock = Semaphore.makeUnsafe(1)

/** Repair journal metadata only after every old row is identified and backed up. */
export const repair = (db: EffectDrizzleSqlite.EffectSQLiteDatabase, beforeRepair: () => Promise<void>) =>
  lock.withPermit(
    Effect.gen(function* () {
      if (!(yield* db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")))
        return false
      const columns = yield* db.all<{ name: string }>("PRAGMA table_info('__drizzle_migrations')")
      if (columns.some((column) => column.name === "name")) return false
      if (!["id", "hash", "created_at"].every((column) => columns.some((entry) => entry.name === column)))
        return yield* Effect.fail(new Error("Unknown legacy browser migration journal format"))
      const rows = yield* db.all<{ id: number; hash: string; created_at: number | null }>(
        "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id",
      )
      if (!rows.length) return false
      // A genuine native Drizzle journal already has valid timestamps. Core owns
      // that migration path; it must not be rewritten as a browser journal.
      if (
        rows.every((row) => {
          if (typeof row.created_at !== "number" || !Number.isFinite(row.created_at)) return false
          const date = new Date(row.created_at)
          if (Number.isNaN(date.getTime())) return false
          const prefix = date.toISOString().replace(/\D/g, "").slice(0, 14)
          return migrations.some((migration) => migration.id.startsWith(prefix + "_"))
        })
      )
        return false
      const mapped = rows.map((row) => ({ ...row, name: known.get(row.hash) }))
      const unknown = mapped.find((row) => !row.name || !names.has(row.name))
      if (unknown) return yield* Effect.fail(new Error("Unknown legacy browser migration hash: " + unknown.hash))
      yield* Effect.tryPromise({
        try: beforeRepair,
        catch: (cause) =>
          new Error("Could not back up the legacy browser database; no journal changes were made", { cause }),
      })
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx.all<{ id: number; hash: string; created_at: number | null }>(
            "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id",
          )
          if (JSON.stringify(current) !== JSON.stringify(rows))
            return yield* Effect.fail(new Error("Legacy browser migration journal changed during backup"))
          yield* tx.run("ALTER TABLE __drizzle_migrations ADD COLUMN name TEXT")
          for (const row of mapped)
            yield* tx.run(
              sql`UPDATE __drizzle_migrations SET name = ${row.name!} WHERE id = ${row.id} AND hash = ${row.hash}`,
            )
        }),
      )
      return true
    }),
  )
