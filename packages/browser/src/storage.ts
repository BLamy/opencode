export type BrowserStorage = "persistent" | "memory"

/** Opaque frames cannot open IndexedDB, even when the API is present. */
export async function loadBrowserStorage(
  origin: string | undefined,
  load: () => Promise<Uint8Array | null>,
): Promise<{ storage: BrowserStorage; saved: Uint8Array | null }> {
  if (origin === "null") return { storage: "memory", saved: null }

  try {
    return { storage: "persistent", saved: await load() }
  } catch (error) {
    if (typeof DOMException === "undefined" || !(error instanceof DOMException) || error.name !== "SecurityError")
      throw error
    return { storage: "memory", saved: null }
  }
}

export function assertPersistentBrowserStorage(origin: string | undefined, storage?: BrowserStorage): void {
  if (origin !== "null" && storage !== "memory") return
  throw Object.assign(
    new Error(
      "Persistent database storage is unavailable in this browser context. The database is memory-only; export a snapshot before closing this page.",
    ),
    { code: "BROWSER_STORAGE_UNAVAILABLE" },
  )
}
