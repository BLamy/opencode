import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

// Core constructs its default native node on import. BrowserBackend replaces
// that node with the WASM SQLite client before the application layer is built.
export const supportsForeignKeyToggle = true
export const supportsTuningPragmas = false

export const sqliteLayer = (_config: { filename: string }) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.die(
      new Error("Native SQLite is unavailable in the browser. Create the server with createBrowserBackend()."),
    ),
  )
