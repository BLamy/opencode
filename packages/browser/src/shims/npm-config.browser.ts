export * as NpmConfig from "./npm-config.browser"

import { Effect } from "effect"
import path from "path"
import { _vfs_getFile } from "./fs.browser"

/** Read the host's virtual npm configuration without loading native npm/Arborist. */
export const load = (cwd: string) =>
  Effect.sync(() => {
    const config: Record<string, string | boolean> = { registry: "https://registry.npmjs.org" }
    const home = process.env.HOME ?? "/opencode"
    for (const file of [path.join(home, ".npmrc"), path.join(cwd, ".npmrc")]) {
      for (const line of (_vfs_getFile(file) ?? "").split(/\r?\n/)) {
        if (/^\s*[#;]/.test(line)) continue
        const match = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line)
        if (!match) continue
        const value = match[2].replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "")
        config[match[1]] = value === "true" ? true : value === "false" ? false : value
      }
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toLowerCase().startsWith("npm_config_") || value === undefined) continue
      config[name.slice(11).replaceAll("_", "-").toLowerCase()] = value
    }
    return config
  })

export const registry = (cwd: string) =>
  load(cwd).pipe(Effect.map((config) => String(config.registry).replace(/\/$/, "")))
