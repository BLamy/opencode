import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"

// Core constructs its default native node on import. BrowserBackend replaces
// that node with the WASM SQLite client before the application layer is built.
export const layer = (_config: { filename: string }) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.die(
      new Error("Native SQLite is unavailable in the browser. Create the server with createBrowserBackend()."),
    ),
  )
