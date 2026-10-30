// Browser database initialization using sql.js (WASM SQLite)
import { browserFetch } from "../browser-fetch"
import type { Database as SqlJsDatabase, SqlJsStatic } from "sql.js"
import sqlJsLoaderUrl from "sql.js/dist/sql-wasm.js?url"
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url"

let _db: SqlJsDatabase | null = null
let _SQL: SqlJsStatic | null = null
let _loaderPromise: Promise<InitSqlJs> | null = null
let _dbPromise: Promise<SqlJsDatabase> | null = null

type InitSqlJs = (config?: { locateFile?: (file: string) => string; wasmBinary?: ArrayBuffer }) => Promise<SqlJsStatic>

function getInitSqlJs(): InitSqlJs | undefined {
  const candidate = (globalThis as unknown as { initSqlJs?: InitSqlJs }).initSqlJs
  return typeof candidate === "function" ? candidate : undefined
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
    script.crossOrigin = "anonymous"
    script.referrerPolicy = "no-referrer"
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

export async function initBrowserDB(): Promise<SqlJsDatabase> {
  if (_db) return _db
  if (_dbPromise) return _dbPromise

  _dbPromise = (async () => {
    const originalProcess = globalThis.process
    const initSqlJs = await loadSqlJs()
    const response = await browserFetch(sqlWasmUrl)
    if (!response.ok) throw new Error(`Failed to load SQLite WASM: ${response.status}`)
    const wasmBinary = await response.arrayBuffer()

    try {
      // sql.js detects Node by checking process.versions.node. Our browser shell
      // provides a process shim for OpenCode/OpenTUI, so temporarily hide it here.
      if (originalProcess) {
        ;(globalThis as { process?: typeof originalProcess }).process = undefined
      }

      _SQL = await initSqlJs({
        locateFile: () => sqlWasmUrl,
        wasmBinary,
      })
    } finally {
      if (originalProcess) {
        globalThis.process = originalProcess
      }
    }

    // v2 stores OAuth credentials in SQLite. Keep its database in this tab;
    // do not open or upgrade the persisted v1 database on this origin.
    _db = new _SQL.Database()
    return _db!
  })()

  try {
    return await _dbPromise
  } catch (error) {
    _dbPromise = null
    throw error
  }
}
