import { createBuiltinPlugins } from "../../tui/src/feature-plugins/builtins"
import type { TuiPluginHost } from "../../tui/src/plugin/runtime"
import type { TuiDispose, TuiPluginStatus, TuiSlotPlugin } from "@opencode-ai/plugin/tui"

/** Runs production builtins through the same slot and lifecycle APIs as native hosts. */
export function createBrowserPlugins(): TuiPluginHost {
  const cleanup = new Set<TuiDispose>()
  const controller = new AbortController()
  return {
    async start(input) {
      const slots = input.runtime.setupSlots(input.api)
      cleanup.add(slots.dispose)
      const status: TuiPluginStatus[] = []
      const plugins = {
        list: () => status,
        activate: async () => false,
        deactivate: async () => false,
        add: async () => false,
        install: async () => ({ ok: false as const, message: "External TUI plugins require a host package manager." }),
      }
      for (const item of createBuiltinPlugins({ experimentalEventSystem: false })) {
        if (item.enabled === false) continue
        let count = 0
        await item.tui(
          {
            ...input.api,
            slots: {
              register(plugin: TuiSlotPlugin) {
                const id = item.id + ":" + count++
                cleanup.add(slots.register({ ...plugin, id }))
                return id
              },
            },
            plugins,
            lifecycle: {
              signal: controller.signal,
              onDispose(fn) {
                cleanup.add(fn)
                return () => {
                  cleanup.delete(fn)
                }
              },
            },
          },
          undefined,
          {
            id: item.id,
            source: "internal",
            spec: item.id,
            target: item.id,
            state: "same",
            first_time: 0,
            last_time: 0,
            time_changed: 0,
            load_count: 1,
            fingerprint: item.id,
          },
        )
        status.push({ id: item.id, source: "internal", spec: item.id, target: item.id, enabled: true, active: true })
      }
      input.runtime.update({ status, commands: plugins })
    },
    async dispose() {
      controller.abort()
      for (const fn of Array.from(cleanup).reverse()) await fn()
      cleanup.clear()
    },
  }
}
