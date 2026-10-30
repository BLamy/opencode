import { beforeAll, expect, test } from "bun:test"
import { createRequire } from "node:module"
import initSqlJs, { type SqlJsStatic } from "sql.js"
import { assertPersistentBrowserStorage, loadBrowserStorage } from "./storage"

const require = createRequire(import.meta.url)
let SQL: SqlJsStatic

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => require.resolve("sql.js/dist/sql-wasm.wasm") })
})

test("opaque origins never access stored data and use a real memory SQLite database", async () => {
  let loaded = false
  const result = await loadBrowserStorage("null", async () => {
    loaded = true
    throw new Error("Opaque origins must not read IndexedDB")
  })
  expect(loaded).toBe(false)
  expect(result).toEqual({ storage: "memory", saved: null })

  const database = new SQL.Database()
  try {
    database.run("CREATE TABLE example (value TEXT NOT NULL)")
    database.run("INSERT INTO example VALUES (?)", ["memory database"])
    expect(database.exec("SELECT value FROM example")[0]?.values).toEqual([["memory database"]])
    expect(database.export().length).toBeGreaterThan(0)
  } finally {
    database.close()
  }
})

test("a genuine IndexedDB SecurityError selects memory storage", async () => {
  const result = await loadBrowserStorage("https://example.com", async () => {
    throw new DOMException("Storage access was denied", "SecurityError")
  })
  expect(result).toEqual({ storage: "memory", saved: null })
})

test("ordinary origins retain the exact saved image and persistent storage", async () => {
  const saved = new Uint8Array([1, 2, 3])
  const result = await loadBrowserStorage("https://example.com", async () => saved)
  expect(result.storage).toBe("persistent")
  expect(result.saved).toBe(saved)
  expect(await loadBrowserStorage("https://example.com", async () => null)).toEqual({
    storage: "persistent",
    saved: null,
  })
})

test("quota, corruption, and unknown errors propagate without selecting memory storage", async () => {
  const errors = [
    new DOMException("Quota exceeded", "QuotaExceededError"),
    new DOMException("Storage is not ready", "InvalidStateError"),
    new Error("file is not a database"),
    new Error("Unknown IndexedDB failure"),
    Object.assign(new Error("Not a DOMException"), { name: "SecurityError" }),
  ]
  for (const error of errors) {
    await expect(
      loadBrowserStorage("https://example.com", async () => {
        throw error
      }),
    ).rejects.toBe(error)
  }
})

test("direct persistence is rejected for opaque or memory-only contexts", () => {
  for (const [origin, storage] of [
    ["null", undefined],
    ["null", "persistent"],
    ["https://example.com", "memory"],
  ] as const) {
    expect(() => assertPersistentBrowserStorage(origin, storage)).toThrow(
      expect.objectContaining({ code: "BROWSER_STORAGE_UNAVAILABLE" }),
    )
  }
  expect(() => assertPersistentBrowserStorage("https://example.com", "persistent")).not.toThrow()
})
