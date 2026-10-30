// Browser database initialization using sql.js (WASM SQLite)
import type { Database as SqlJsDatabase, SqlJsStatic } from "sql.js"
import sqlJsLoaderUrl from "sql.js/dist/sql-wasm.js?url"
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url"
import { assertPersistentBrowserStorage, loadBrowserStorage, type BrowserStorage } from "../storage"

let _db: SqlJsDatabase | null = null
let _SQL: SqlJsStatic | null = null
let _loaderPromise: Promise<InitSqlJs> | null = null
let _dbPromise: Promise<SqlJsDatabase> | null = null
let _storage: BrowserStorage | undefined

const IDB_KEY = "opencode-db-v2"
const IDB_STORE = "opencode"
const IDB_DB = "opencode-storage-v2"
const IDB_UPGRADE_BACKUP_KEY = "opencode-db-v2-before-1.19.5"

type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

function getInitSqlJs(): InitSqlJs | undefined {
  const candidate = (globalThis as unknown as { initSqlJs?: InitSqlJs }).initSqlJs
  return typeof candidate === "function" ? candidate : undefined
}

function getErrorText(error: unknown, depth = 0): string {
  if (depth >= 4 || error == null) {
    return ""
  }

  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return [error.message, error.stack, getErrorText(error.cause, depth + 1)].filter(Boolean).join("\n")
  }

  if (typeof error === "object") {
    const message = "message" in error && typeof error.message === "string" ? error.message : ""
    const cause = "cause" in error ? getErrorText(error.cause, depth + 1) : ""
    return [message, cause].filter(Boolean).join("\n")
  }

  return String(error)
}

export function isRecoverableBrowserDBError(error: unknown): boolean {
  const text = getErrorText(error).toLowerCase()
  return (
    text.includes("out of memory") ||
    text.includes("file is not a database") ||
    text.includes("database disk image is malformed")
  )
}

function closeBrowserDB(): void {
  if (_db && typeof (_db as { close?: () => void }).close === "function") {
    ;(_db as { close: () => void }).close()
  }
}

function loadSqlJs(): Promise<InitSqlJs> {
  const existing = getInitSqlJs()
  if (existing) {
    return Promise.resolve(existing)
  }

  if (_loaderPromise) {
    return _loaderPromise
  }

  _loaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = sqlJsLoaderUrl
    script.async = true
    script.dataset.sqlJsLoader = "true"
    script.onload = () => {
      const initSqlJs = getInitSqlJs()
      if (!initSqlJs) {
        reject(new Error("sql.js loader did not expose initSqlJs"))
        return
      }
      resolve(initSqlJs)
    }
    script.onerror = () => {
      reject(new Error(`Failed to load sql.js loader from ${sqlJsLoaderUrl}`))
    }
    document.head.append(script)
  })

  return _loaderPromise
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    assertPersistentBrowserStorage(globalThis.origin, _storage)
    const request = indexedDB.open(IDB_DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(IDB_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadFromIDB(key = IDB_KEY): Promise<Uint8Array | null> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly")
    const store = tx.objectStore(IDB_STORE)
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

async function saveToIDB(data: Uint8Array): Promise<void> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite")
    const store = tx.objectStore(IDB_STORE)
    store.put(data, IDB_KEY)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

/** Keep the first pre-upgrade image even after the live database is persisted. */
export async function backupBrowserDBBeforeUpgrade(data: Uint8Array): Promise<void> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite")
    const store = tx.objectStore(IDB_STORE)
    const request = store.get(IDB_UPGRADE_BACKUP_KEY)
    request.onsuccess = () => {
      if (request.result === undefined) store.put(new Uint8Array(data), IDB_UPGRADE_BACKUP_KEY)
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error("Database backup was aborted"))
    }
  })
}

export const exportBrowserDBUpgradeBackup = () => loadFromIDB(IDB_UPGRADE_BACKUP_KEY)

async function clearIDB(): Promise<void> {
  const db = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite")
    const store = tx.objectStore(IDB_STORE)
    store.delete(IDB_KEY)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function initBrowserDB(): Promise<SqlJsDatabase> {
  if (_db) return _db
  if (_dbPromise) return _dbPromise

  _dbPromise = (async () => {
    const originalProcess = globalThis.process
    const initSqlJs = await loadSqlJs()

    try {
      // sql.js detects Node by checking process.versions.node. Our browser shell
      // provides a process shim for OpenCode/OpenTUI, so temporarily hide it here.
      if (originalProcess) {
        ;(globalThis as { process?: typeof originalProcess }).process = undefined
      }

      _SQL = await initSqlJs({
        locateFile: () => sqlWasmUrl,
      })
    } finally {
      if (originalProcess) {
        globalThis.process = originalProcess
      }
    }

    const { storage, saved } = await loadBrowserStorage(globalThis.origin, loadFromIDB)
    if (!saved) {
      _db = new _SQL.Database()
      _storage = storage
      return _db
    }

    try {
      _db = new _SQL.Database(saved)
    } catch (error) {
      if (!isRecoverableBrowserDBError(error)) {
        throw error
      }

      throw Object.assign(
        new Error(
          "Your saved browser database could not be opened. Its stored data has been preserved. Download a database backup before attempting recovery.",
          { cause: error },
        ),
        { code: "BROWSER_DATABASE_UPGRADE_REQUIRED", originalSnapshot: new Uint8Array(saved) },
      )
    }

    _storage = storage
    return _db!
  })()

  try {
    return await _dbPromise
  } catch (error) {
    _dbPromise = null
    throw error
  }
}

export function getBrowserDB(): SqlJsDatabase {
  if (!_db) throw new Error("Browser DB not initialized. Call initBrowserDB() first.")
  return _db
}

/** The storage mode selected by successful database initialization. */
export function getBrowserDBStorage(): BrowserStorage {
  if (!_db || !_storage) throw new Error("Browser DB not initialized. Call initBrowserDB() first.")
  return _storage
}

export async function persistDB(snapshot?: Uint8Array): Promise<void> {
  assertPersistentBrowserStorage(globalThis.origin, _storage)
  if (!_db) return
  const data = snapshot ?? _db.export()
  await saveToIDB(data)
}

/** Whether a (live or persisted) browser DB already exists. */
export async function hasPersistedBrowserDB(): Promise<boolean> {
  if (globalThis.origin === "null" || _storage === "memory") return false
  if (_db) return true
  const { saved } = await loadBrowserStorage(globalThis.origin, loadFromIDB)
  return saved !== null && saved.length > 0
}

export async function exportBrowserDBSnapshot(): Promise<Uint8Array | null> {
  if (_db) {
    return new Uint8Array(_db.export())
  }

  if (globalThis.origin === "null" || _storage === "memory") return null
  const { saved } = await loadBrowserStorage(globalThis.origin, loadFromIDB)
  return saved ? new Uint8Array(saved) : null
}

export async function importBrowserDBSnapshot(data: Uint8Array | null): Promise<void> {
  assertPersistentBrowserStorage(globalThis.origin, _storage)
  closeBrowserDB()

  _db = null
  _dbPromise = null
  _storage = undefined

  if (data && data.length > 0) {
    await saveToIDB(new Uint8Array(data))
  } else {
    await clearIDB()
  }

  await initBrowserDB()
}

export async function resetBrowserDB(): Promise<SqlJsDatabase> {
  assertPersistentBrowserStorage(globalThis.origin, _storage)
  closeBrowserDB()
  _db = null
  _dbPromise = null
  _storage = undefined
  await clearIDB()
  return initBrowserDB()
}

// Auto-persist every 5 seconds
let _persistInterval: ReturnType<typeof setInterval> | null = null
export function startAutoPersist(intervalMs = 5000) {
  if (_persistInterval || globalThis.origin === "null" || _storage !== "persistent") return
  _persistInterval = setInterval(() => persistDB(), intervalMs)
}

export function stopAutoPersist() {
  if (_persistInterval) {
    clearInterval(_persistInterval)
    _persistInterval = null
  }
}

// Drizzle-compatible init function (matches the #db interface)
import { drizzle } from "drizzle-orm/sql-js"

export function init(_path: string) {
  const db = getBrowserDB()
  return drizzle(db)
}
