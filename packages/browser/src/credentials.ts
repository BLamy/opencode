import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Fiber, Layer, Schema } from "effect"

/** The host owns encryption and user-approved unlocking. No database/session snapshot crosses this boundary. */
export interface BrowserCredentialStore {
  readonly version: 1
  readonly unlocked: () => boolean
  readonly load: () => Promise<unknown>
  readonly save: (entries: unknown) => Promise<void>
  readonly subscribe: (listener: () => void) => () => void
}

const Entry = Schema.Struct({ ...Credential.Info.fields, active: Schema.Boolean })
type Entry = typeof Entry.Type

interface Change<T> {
  result: T
  integrationID?: Credential.Info["integrationID"]
  selected?: Credential.ID | null
}

/** Credential operations over the supported host store, without retaining a decrypted cache. */
export function createBrowserCredentials(store: BrowserCredentialStore) {
  const decode = Schema.decodeUnknownSync(Schema.Array(Entry))
  const unlocked = () => {
    if (!store.unlocked()) throw new Error("Unlock the Passwords keychain before changing OpenCode sign-ins.")
  }
  const read = async (): Promise<Entry[]> => {
    if (!store.unlocked()) return []
    const entries = await store.load().then(
      (value) => {
        try {
          return [...decode(value ?? [])]
        } catch {
          throw new Error("The OpenCode keychain slot could not be read.")
        }
      },
      () => {
        throw new Error("The OpenCode keychain slot could not be read.")
      },
    )
    return store.unlocked() ? entries : []
  }
  let pending = Promise.resolve()
  const change = <T>(update: (entries: Entry[]) => { entries: Entry[]; change: Change<T> }): Promise<Change<T>> => {
    const operation = pending.then(async () => {
      unlocked()
      const entries = await read()
      unlocked()
      const next = update(entries)
      await store.save(next.entries).catch(() => {
        throw new Error("OpenCode could not save sign-ins to the encrypted Passwords keychain.")
      })
      unlocked()
      return next.change
    })
    pending = operation.then(
      () => {},
      () => {},
    )
    return operation
  }
  const info = (entry: Entry) => new Credential.Info(entry)
  const ordered = (entries: Entry[]) => entries.toSorted((a, b) => Number(a.active) - Number(b.active))
  return {
    all: async () => ordered(await read()).map(info),
    list: async (integrationID: Credential.Info["integrationID"]) =>
      ordered(await read())
        .filter((entry) => entry.integrationID === integrationID)
        .map(info),
    get: async (id: Credential.ID) => {
      const entry = (await read()).find((entry) => entry.id === id)
      return entry ? info(entry) : undefined
    },
    create: (input: Parameters<Credential.Interface["create"]>[0]) =>
      change((entries) => {
        const active = input.activate !== false || !entries.some((entry) => entry.integrationID === input.integrationID)
        const entry: Entry = {
          id: input.id ?? Credential.ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
          active,
        }
        if (entries.some((item) => item.id === entry.id)) throw new Error("That OpenCode sign-in already exists.")
        return {
          entries: [
            ...entries.map((item) =>
              active && item.integrationID === entry.integrationID ? { ...item, active: false } : item,
            ),
            entry,
          ],
          change: {
            result: info(entry),
            integrationID: entry.integrationID,
            ...(active ? { selected: entry.id } : {}),
          },
        }
      }),
    activate: (id: Credential.ID) =>
      change((entries) => {
        const entry = entries.find((entry) => entry.id === id)
        return {
          entries: entries.map((item) =>
            entry && item.integrationID === entry.integrationID ? { ...item, active: item.id === id } : item,
          ),
          change: { result: undefined, ...(entry ? { integrationID: entry.integrationID, selected: id } : {}) },
        }
      }),
    update: (id: Credential.ID, updates: Partial<Pick<Credential.Info, "label" | "value">>) =>
      change((entries) => ({
        entries: entries.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                ...(updates.label !== undefined ? { label: updates.label } : {}),
                ...(updates.value !== undefined ? { value: updates.value } : {}),
              }
            : entry,
        ),
        change: { result: undefined },
      })),
    remove: (id: Credential.ID) =>
      change((entries) => {
        const removed = entries.find((entry) => entry.id === id)
        const remaining = entries.filter((entry) => entry.id !== id)
        const replacement = removed?.active
          ? remaining.findLast((entry) => entry.integrationID === removed.integrationID)
          : undefined
        return {
          entries: remaining.map((entry) => (entry === replacement ? { ...entry, active: true } : entry)),
          change: {
            result: undefined,
            ...(removed?.active ? { integrationID: removed.integrationID, selected: replacement?.id ?? null } : {}),
          },
        }
      }),
  }
}

/** Replace Core's credential node so device auth, token refresh and logout all use the host's encrypted slot. */
export function browserCredentialNode(store: BrowserCredentialStore) {
  const layer = Layer.effect(
    Credential.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const scope = yield* Effect.scope
      const pending = new Map<Credential.ID, Fiber.Fiber<Credential.OAuth | undefined, unknown>>()
      const credentials = createBrowserCredentials(store)
      const publish = <T>(change: Change<T>) =>
        Effect.gen(function* () {
          yield* bus.publish(Credential.Event.Updated, {}, { global: true })
          if (change.integrationID && change.selected !== undefined)
            yield* bus.publish(
              Credential.Event.Switched,
              { integrationID: change.integrationID, credentialID: change.selected },
              { global: true },
            )
          return change.result
        })
      return Credential.Service.of({
        all: () => Effect.promise(credentials.all),
        list: (id) => Effect.promise(() => credentials.list(id)),
        get: (id) => Effect.promise(() => credentials.get(id)),
        create: (input) => Effect.promise(() => credentials.create(input)).pipe(Effect.flatMap(publish)),
        activate: (id) => Effect.promise(() => credentials.activate(id)).pipe(Effect.flatMap(publish)),
        update: (id, updates) => Effect.promise(() => credentials.update(id, updates)).pipe(Effect.flatMap(publish)),
        remove: (id) => Effect.promise(() => credentials.remove(id)).pipe(Effect.flatMap(publish)),
        lock: (id, operation) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const current = pending.get(id)
              if (current) return yield* restore(Fiber.join(current))
              const fiber = yield* operation.pipe(
                Effect.ensuring(Effect.sync(() => pending.delete(id))),
                Effect.forkIn(scope),
              )
              pending.set(id, fiber)
              return yield* restore(Fiber.join(fiber))
            }),
          ),
      })
    }),
  )
  return makeGlobalNode({ service: Credential.Service, layer, deps: [Bus.node] })
}
