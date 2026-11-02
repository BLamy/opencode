import { expect, test } from "bun:test"
import { Credential } from "@opencode/core/credential"
import { createBrowserCredentials, type BrowserCredentialStore } from "./credentials"

const integrationID = Credential.Info.fields.integrationID.make("openai")
const value = {
  type: "oauth" as const,
  methodID: Credential.OAuth.fields.methodID.make("chatgpt-headless"),
  refresh: "synthetic-refresh",
  access: "synthetic-access",
  expires: 123456789,
}
function fixture() {
  let entries: unknown = []
  let unlocked = true
  const store: BrowserCredentialStore = {
    version: 1,
    unlocked: () => unlocked,
    load: async () => structuredClone(entries),
    save: async (next) => {
      entries = structuredClone(next)
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

test("saves provider auth, restores after a fresh runtime, and saves token refresh", async () => {
  const f = fixture()
  const service = createBrowserCredentials(f.store)
  const created = await service.create({ integrationID, value })
  expect((await createBrowserCredentials(f.store).get(created.result.id))?.value).toEqual(value)
  await service.update(created.result.id, {
    value: { ...value, access: "synthetic-refreshed", refresh: "synthetic-rotated" },
  })
  expect((await createBrowserCredentials(f.store).get(created.result.id))?.value).toMatchObject({
    access: "synthetic-refreshed",
    refresh: "synthetic-rotated",
  })
})

test("lock makes credentials unavailable and prevents writes; unlock restores the saved slot", async () => {
  const f = fixture()
  const service = createBrowserCredentials(f.store)
  const created = await service.create({ integrationID, value })
  f.lock()
  expect(await service.all()).toEqual([])
  expect(await service.get(created.result.id)).toBeUndefined()
  await expect(service.update(created.result.id, { label: "locked" })).rejects.toThrow("Unlock the Passwords keychain")
  f.unlock()
  expect((await service.get(created.result.id))?.value).toEqual(value)
})

test("logout removes auth from the slot and subsequent runtimes", async () => {
  const f = fixture()
  const service = createBrowserCredentials(f.store)
  const created = await service.create({ integrationID, value })
  await service.remove(created.result.id)
  expect(await createBrowserCredentials(f.store).all()).toEqual([])
})

test("serializes concurrent writes and preserves selected credentials", async () => {
  const f = fixture()
  const service = createBrowserCredentials(f.store)
  const [first, second] = await Promise.all([
    service.create({ integrationID, value, label: "first" }),
    service.create({ integrationID, value, label: "second", activate: false }),
  ])
  expect((await service.list(integrationID)).at(-1)?.id).toBe(first.result.id)
  await service.activate(second.result.id)
  expect((await service.list(integrationID)).at(-1)?.id).toBe(second.result.id)
  await service.remove(second.result.id)
  expect((await service.list(integrationID)).at(-1)?.id).toBe(first.result.id)
})

test("storage failures are redacted and never reported as a successful save", async () => {
  const f = fixture()
  const failing = createBrowserCredentials({
    ...f.store,
    save: async () => {
      throw new Error("synthetic-access")
    },
  })
  await expect(failing.create({ integrationID, value })).rejects.toThrow("could not save sign-ins")
  expect(await createBrowserCredentials(f.store).all()).toEqual([])
})
