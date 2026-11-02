import { Schema } from "effect"
import type { BrowserCredentialStore } from "./credentials"
import type { TailscalePersistence, TailscaleSession } from "./vendor/tailscale/tailscale"

export type BrowserConnectionStore = BrowserCredentialStore

const State = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literals(["offline", "proxy", "tailscale"]),
  session: Schema.NullOr(
    Schema.Struct({
      v: Schema.Literal(1),
      hostname: Schema.String,
      state: Schema.Record(Schema.String, Schema.String),
      exitNodeId: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

/** One encrypted record keeps the chosen transport and node together. Updates share a queue so an exit-node save
 * cannot overwrite a simultaneous connection choice. No decrypted record is cached outside the Tailscale client. */
export function createBrowserConnectionState(store: BrowserConnectionStore) {
  const decode = Schema.decodeUnknownSync(State)
  const load = async () => {
    if (!store.unlocked()) return null
    const value = await store.load().catch(() => {
      throw new Error("The OpenCode connection could not be read from Passwords.")
    })
    if (!store.unlocked() || value == null) return null
    try {
      return decode(value)
    } catch {
      throw new Error("The saved OpenCode connection could not be read.")
    }
  }
  let pending = Promise.resolve()
  const update = (change: (state: typeof State.Type) => typeof State.Type) => {
    const operation = pending.then(async () => {
      if (!store.unlocked()) throw new Error("Unlock Passwords to save your OpenCode connection.")
      const state = await load()
      if (!store.unlocked()) throw new Error("Unlock Passwords to save your OpenCode connection.")
      await store.save(change(state ?? { v: 1, type: "offline", session: null })).catch(() => {
        throw new Error("OpenCode could not save the connection to Passwords.")
      })
    })
    pending = operation.catch(() => {})
    return operation
  }
  const persistence: TailscalePersistence = {
    load: async () => (await load())?.session ?? null,
    save: (session: TailscaleSession) => update((state) => ({ ...state, session })),
    clear: () =>
      update((state) => ({ ...state, session: null, type: state.type === "tailscale" ? "offline" : state.type })),
  }
  return {
    load,
    select: (type: (typeof State.Type)["type"]) => update((state) => ({ ...state, type })),
    persistence,
  }
}
