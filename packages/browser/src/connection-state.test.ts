import { expect, test } from "bun:test"
import { createBrowserConnectionState, type BrowserConnectionStore } from "./connection-state"
import { createTailscale, type TailscaleClientStartOptions } from "./vendor/tailscale/tailscale"

function fixture() {
  let value: unknown = null
  let unlocked = true
  const store: BrowserConnectionStore = {
    version: 1,
    unlocked: () => unlocked,
    load: async () => structuredClone(value),
    save: async (next) => {
      value = structuredClone(next)
    },
    subscribe: () => () => {},
  }
  return {
    store,
    lock: () => {
      unlocked = false
    },
    unlock: () => {
      unlocked = true
    },
  }
}

const session = {
  v: 1 as const,
  hostname: "opencode-browser",
  state: { _machinekey: "synthetic-private-key" },
  exitNodeId: "exit-node",
}

test("restores the selected private connection, node keys and exit node in a fresh runtime", async () => {
  const f = fixture()
  const first = createBrowserConnectionState(f.store)
  expect(await first.load()).toBeNull()
  await first.persistence.save(session)
  await first.select("tailscale")
  const refreshed = createBrowserConnectionState(f.store)
  expect(await refreshed.load()).toEqual({ v: 1, type: "tailscale", session })
  expect(await refreshed.persistence.load()).toEqual(session)
})

test("a restored Tailscale controller starts the saved device and exit node without interactive login", async () => {
  const f = fixture()
  const saved = createBrowserConnectionState(f.store)
  await saved.persistence.save(session)
  await saved.select("tailscale")
  let start: TailscaleClientStartOptions | undefined
  let logins = 0
  const client = createTailscale({
    persistence: createBrowserConnectionState(f.store).persistence,
    lockName: false,
    env: {
      open: () => {
        throw new Error("Restore opened a sign-in popup")
      },
    },
    client: {
      start: async (options) => {
        start = options
        options.onEvent({
          state: "Running",
          netMap: {
            self: { name: "opencode-browser.tailnet.ts.net", addresses: ["100.64.0.1"] },
            peers: [{ id: "exit-node", name: "exit", addresses: ["100.64.0.2"], exitNodeOption: true, online: true }],
            selectedExitNodeId: options.exitNodeId,
          },
        })
      },
      login: () => {
        logins++
      },
      logout: () => {},
      fetch: async () => ({ status: 200, headers: [], body: null }),
      setExitNode: () => {},
      dispose: () => {},
    },
  })
  try {
    await client.connect()
    expect(start?.hostname).toBe(session.hostname)
    expect(start?.state).toEqual(session.state)
    expect(start?.exitNodeId).toBe("exit-node")
    expect(client.getSnapshot()).toMatchObject({ status: "connected", exitNodeId: "exit-node" })
    expect(logins).toBe(0)
    await client.signOut()
    expect(await createBrowserConnectionState(f.store).load()).toEqual({ v: 1, type: "offline", session: null })
  } finally {
    await client.dispose()
  }
})

test("locking hides saved connections and prevents node keys from being written", async () => {
  const f = fixture()
  const saved = createBrowserConnectionState(f.store)
  await saved.persistence.save(session)
  await saved.select("tailscale")
  f.lock()
  expect(await saved.load()).toBeNull()
  expect(await saved.persistence.load()).toBeNull()
  await expect(saved.persistence.save(session)).rejects.toThrow("Unlock Passwords")
  await expect(saved.select("proxy")).rejects.toThrow("Unlock Passwords")
  f.unlock()
  expect(await saved.load()).toEqual({ v: 1, type: "tailscale", session })
})

test("concurrent node and connection updates preserve both records", async () => {
  const f = fixture()
  const saved = createBrowserConnectionState(f.store)
  await Promise.all([saved.persistence.save(session), saved.select("tailscale")])
  expect(await saved.load()).toEqual({ v: 1, type: "tailscale", session })
  await Promise.all([saved.select("proxy"), saved.persistence.save({ ...session, exitNodeId: "other-exit" })])
  expect(await saved.load()).toEqual({ v: 1, type: "proxy", session: { ...session, exitNodeId: "other-exit" } })
})

test("offline remains offline after reload and signing out forgets the private device", async () => {
  const f = fixture()
  const saved = createBrowserConnectionState(f.store)
  await saved.persistence.save(session)
  await saved.select("offline")
  expect((await createBrowserConnectionState(f.store).load())?.type).toBe("offline")
  await saved.select("tailscale")
  await saved.persistence.clear()
  expect(await createBrowserConnectionState(f.store).load()).toEqual({ v: 1, type: "offline", session: null })
})

test("unreadable data and failed saves report no node keys and preserve the stored record", async () => {
  const f = fixture()
  await f.store.save({ v: 1, type: "tailscale", session: { ...session, state: { _machinekey: 42 } } })
  await expect(createBrowserConnectionState(f.store).load()).rejects.toThrow(
    "saved OpenCode connection could not be read",
  )
  await f.store.save(null)
  const saved = createBrowserConnectionState({
    ...f.store,
    save: async () => {
      throw new Error("synthetic-private-key")
    },
  })
  await expect(saved.persistence.save(session)).rejects.toThrow("could not save the connection to Passwords")
  expect(await createBrowserConnectionState(f.store).load()).toBeNull()
})
