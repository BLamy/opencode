export * as Npm from "./npm.browser"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { runBrowserCommand } from "./child-process.browser"
import { _vfs_exists, _vfs_getFile, _vfs_addDir } from "./fs.browser"

export class InstallFailedError extends Schema.TaggedErrorClass<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.optional(Schema.Array(Schema.String)),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint?: string
}
export interface Interface {
  readonly add: (pkg: string) => Effect.Effect<EntryPoint, InstallFailedError>
  readonly install: (
    dir: string,
    input?: { add: { name: string; version?: string }[] },
  ) => Effect.Effect<void, InstallFailedError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<string | undefined>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/Npm") {}
export const sanitize = (pkg: string) => encodeURIComponent(pkg)

function reify(dir: string, add: string[]) {
  return Effect.tryPromise({
    try: async () => {
      _vfs_addDir(dir)
      const result = await runBrowserCommand({
        command: "npm",
        args: ["install", "--ignore-scripts", ...add],
        cwd: dir,
      })
      if (result.code) throw new Error(result.stderr || result.stdout || "Package installation failed")
    },
    catch: (cause) => new InstallFailedError({ dir, add, cause }),
  })
}

const service: Interface = {
  install: (dir, input) => reify(dir, input?.add.map((pkg) => pkg.name + (pkg.version ? "@" + pkg.version : "")) ?? []),
  add: (pkg) =>
    Effect.gen(function* () {
      const dir = path.join("/opencode/cache/packages", sanitize(pkg))
      const name = pkg.replace(/@[^/]*$/, "") || pkg
      const directory = path.join(dir, "node_modules", name)
      if (!_vfs_exists(directory)) yield* reify(dir, [pkg])
      const text = _vfs_getFile(path.join(directory, "package.json"))
      if (!text)
        return yield* new InstallFailedError({
          dir,
          add: [pkg],
          cause: new Error("The host package manager did not create " + directory),
        })
      const manifest = JSON.parse(text) as { module?: string; main?: string }
      return { directory, entrypoint: path.join(directory, manifest.module ?? manifest.main ?? "index.js") }
    }),
  which: (pkg, bin) =>
    Effect.sync(() => {
      const dir = path.join(
        "/opencode/cache/packages",
        sanitize(pkg),
        "node_modules/.bin",
        bin ?? pkg.split("/").at(-1)!,
      )
      return _vfs_exists(dir) ? dir : undefined
    }),
}

const layer = Layer.succeed(Service, service)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

export const install = (...args: Parameters<Interface["install"]>) => Effect.runPromise(service.install(...args))
export const add = (...args: Parameters<Interface["add"]>) => Effect.runPromise(service.add(...args))
export const which = (...args: Parameters<Interface["which"]>) => Effect.runPromise(service.which(...args))
