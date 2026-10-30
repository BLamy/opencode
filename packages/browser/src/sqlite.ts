export * as BrowserSqlite from "./sqlite"

import { Context, Effect, Layer, Semaphore, Stream } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import { SqlClient, Statement } from "effect/unstable/sql"

type Value = string | number | null | Uint8Array

/** The synchronous prepared-statement surface supplied by WASM SQLite. */
export interface Database {
  prepare(sql: string): {
    bind(values: Value[]): boolean
    step(): boolean
    get(values?: null, options?: { useBigInt?: boolean }): unknown[]
    getAsObject(values?: null, options?: { useBigInt?: boolean }): Record<string, unknown>
    free(): boolean
  }
  export(): Uint8Array
}

const locks = new WeakMap<Database, Semaphore.Semaphore>()

function lock(database: Database) {
  const existing = locks.get(database)
  if (existing) return existing
  const semaphore = Semaphore.makeUnsafe(1)
  locks.set(database, semaphore)
  return semaphore
}

function parameter(input: unknown): Value {
  if (input === null || typeof input === "string" || typeof input === "number" || input instanceof Uint8Array)
    return input
  if (typeof input === "boolean") return input ? 1 : 0
  if (typeof input === "bigint" && Number.isSafeInteger(Number(input))) return Number(input)
  throw new TypeError(`Unsupported WASM SQLite parameter: ${typeof input}`)
}

export const make = (database: Database) =>
  Effect.gen(function* () {
    const semaphore = lock(database)
    const run = (sql: string, params: ReadonlyArray<unknown>, values: boolean) =>
      Effect.withFiber((fiber) =>
        Effect.try({
          try: () => {
            const statement = database.prepare(sql)
            try {
              statement.bind(params.map(parameter))
              const options = { useBigInt: Context.get(fiber.context, SqlClient.SafeIntegers) }
              const rows: Array<Record<string, unknown> | unknown[]> = []
              while (statement.step())
                rows.push(values ? statement.get(null, options) : statement.getAsObject(null, options))
              return rows
            } finally {
              statement.free()
            }
          },
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to execute WASM SQLite statement",
                operation: "execute",
              }),
            }),
        }),
      )

    const connection: Connection = {
      execute(sql, params, transformRows) {
        const rows = run(sql, params, false)
        return transformRows ? rows.pipe(Effect.map((rows) => transformRows(rows as Record<string, unknown>[]))) : rows
      },
      executeRaw: (sql, params) => run(sql, params, false),
      executeValues: (sql, params) => run(sql, params, true) as Effect.Effect<unknown[][], SqlError>,
      executeUnprepared(sql, params, transformRows) {
        return this.execute(sql, params, transformRows)
      },
      executeStream(sql, params, transformRows) {
        return Stream.unwrap(this.execute(sql, params, transformRows).pipe(Effect.map(Stream.fromIterable)))
      },
    }

    // A query owns the connection until its scope closes. Transactions reserve
    // the same permit across yields; their nested statements reuse that lease.
    const acquirer = Effect.acquireRelease(semaphore.take(1), () => semaphore.release(1)).pipe(Effect.as(connection))

    return yield* SqlClient.make({
      acquirer,
      transactionAcquirer: acquirer,
      compiler: Statement.makeCompilerSqlite(),
      spanAttributes: [["db.system.name", "sqlite"]],
    })
  })

export const layer = (database: Database) =>
  Layer.effect(SqlClient.SqlClient, make(database)).pipe(Layer.provide(Reactivity.layer))

/** Serialize snapshots with queries and transactions, including other clients. */
export const exclusive = <A, E, R>(database: Database, effect: Effect.Effect<A, E, R>) =>
  lock(database).withPermit(effect)

export const snapshot = (database: Database) =>
  exclusive(
    database,
    Effect.try({
      try: () => {
        const pragma = database.prepare("PRAGMA foreign_keys")
        const enabled = (() => {
          try {
            return pragma.step() && pragma.get()[0] === 1
          } finally {
            pragma.free()
          }
        })()
        try {
          return database.export()
        } finally {
          // sql.js exports by reopening its connection, which resets this
          // connection-local setting even though the database schema survives.
          if (enabled) {
            const restore = database.prepare("PRAGMA foreign_keys = ON")
            try {
              restore.step()
            } finally {
              restore.free()
            }
          }
        }
      },
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, { message: "Failed to export WASM SQLite database", operation: "export" }),
        }),
    }),
  )
