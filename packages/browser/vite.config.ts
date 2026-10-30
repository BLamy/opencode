import { existsSync, readFileSync } from "node:fs"
import { cp } from "node:fs/promises"
import path from "node:path"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { defineConfig, type Plugin } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"

const root = path.resolve(__dirname, "../..")
const opentui = path.resolve(
  process.env.OPENTUI_DIR ??
    (existsSync(path.join(root, "vendor/opentui")) ? path.join(root, "vendor/opentui") : path.join(root, "../opentui")),
)
const core = path.join(opentui, "packages/core")
const shims = path.join(core, "src/browser/shims")
const version = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8")).version
const runtime = JSON.parse(readFileSync(path.join(__dirname, "opentui.json"), "utf8"))
if (JSON.parse(readFileSync(path.join(core, "package.json"), "utf8")).version !== runtime.version)
  throw new Error("OpenTUI checkout does not match packages/browser/opentui.json")

function exports(name: string) {
  const dir = path.join(opentui, "packages", name)
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
  return Object.entries(pkg.exports).map(([key, entry]) => ({
    find: new RegExp(`^@opentui/${name}${key === "." ? "" : key.slice(1)}$`),
    replacement: path.join(dir, typeof entry === "string" ? entry : (entry as { import: string }).import),
  }))
}

function platform(): Plugin {
  const names = [
    "buffer",
    "console",
    "crypto",
    "events",
    "fs",
    "fs/promises",
    "module",
    "os",
    "path",
    "process",
    "stream",
    "url",
    "util",
  ]
  return {
    name: "opentui-browser-platform",
    enforce: "pre",
    transform(code, id) {
      const source = id.split("?")[0]
      if (source.endsWith("/@agent-wasm/tailscale-connect/pkg.js")) {
        if (!code.includes("fetch(wasmURL)")) this.error("Tailscale WASM loader changed")
        return {
          code: `import { browserFetch } from ${JSON.stringify(path.join(__dirname, "src/browser-fetch.ts"))}\n` + code.replace("fetch(wasmURL)", "browserFetch(wasmURL)"),
          map: null,
        }
      }
      if (source.startsWith(path.join(root, "packages/"))) {
        code = code.replace(
          /import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?crypto["']/g,
          (statement, bindings: string) => {
            const names = bindings.split(",").map((name) => name.trim())
            if (!names.includes("randomUUID")) return statement
            const remaining = names.filter((name) => name !== "randomUUID")
            return (
              `import { randomUUID } from ${JSON.stringify(path.join(__dirname, "src/shims/uuid.browser.ts"))}\n` +
              (remaining.length ? `import { ${remaining.join(", ")} } from "node:crypto"` : "")
            )
          },
        )
      }
      if (source.startsWith(path.join(root, "packages/"))) {
        code = code.replace(/import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?util["']/g, (statement, bindings: string) => {
          const names = bindings.split(",").map((name) => name.trim())
          if (!names.includes("isDeepStrictEqual")) return statement
          const remaining = names.filter((name) => name !== "isDeepStrictEqual")
          return (
            `import { isDeepStrictEqual } from ${JSON.stringify(path.join(__dirname, "src/shims/deep-equal.browser.ts"))}\n` +
            (remaining.length ? `import { ${remaining.join(", ")} } from "node:util"` : "")
          )
        })
      }
      if (source.startsWith(path.join(root, "packages/tui/src/")) && code.includes(".unref()")) {
        code =
          `import { setTimeout, clearTimeout, setInterval, clearInterval } from ${JSON.stringify(path.join(__dirname, "src/shims/timers.browser.ts"))}\n` +
          code
      }
      if (source.includes("/node_modules/bun-ffi-structs/") && code.includes("var backend = await loadBackend();")) {
        return {
          code:
            'import browserStructFfi from "virtual:opentui-struct-ffi"\n' +
            code.replace("var backend = await loadBackend();", "var backend = browserStructFfi;"),
          map: null,
        }
      }
      const auth = source.startsWith(path.join(root, "packages/core/src/plugin/provider/"))
      if (!auth || !/\bfetch\b/.test(code) || /import[^\n]*\bfetch\b/.test(code)) return { code, map: null }
      if (source === path.join(root, "packages/core/src/plugin/provider/openai.ts")) {
        const browserRegistration = "      editor.method.update(browser(ctx.app))"
        if (!code.includes(browserRegistration)) this.error("OpenAI auth registration changed")
        code = code.replace(browserRegistration, "")
      }
      if (source === path.join(root, "packages/core/src/plugin/provider/chatgpt.ts")) {
        const nativeLogin = `      editor.method.update(
        signIn(ctx.app, () => Option.getOrUndefined(decodeMetadata(chatgpt?.metadata))?.clientID, ctx.storage),
      )`
        if (!code.includes(nativeLogin)) this.error("ChatGPT loopback auth registration changed")
        code = code.replace(nativeLogin, "")
      }
      // A lexical browser-only fetch keeps the native plugin and the global browser network unchanged.
      return {
        code: `import { fetch } from ${JSON.stringify(path.join(__dirname, "src/provider-network.ts"))}\n${code}`,
        map: null,
      }
    },
    load(id) {
      if (id === "\0opentui-struct-ffi")
        return `import { ptr, toArrayBuffer } from ${JSON.stringify(path.join(core, "src/platform/ffi.ts"))}; export default { ptr, toArrayBuffer };`
    },
    resolveId(source, importer) {
      if (source === "virtual:opentui-struct-ffi") return "\0opentui-struct-ffi"
      if (source === "opencode-web-ui.gen.ts") return { id: source, external: true }
      if (source.endsWith(".wasm")) return this.resolve(source + "?url", importer, { skipSelf: true })
      if (/stream-browserify\/(promises|consumers)$/.test(source))
        return path.join(__dirname, "src/shims/stream-" + source.split("/").at(-1) + ".browser.ts")
      if (source.startsWith("vite-plugin-node-polyfills/shims/")) {
        const name = source.slice("vite-plugin-node-polyfills/shims/".length)
        return path.join(__dirname, "node_modules/vite-plugin-node-polyfills/shims", name, "dist/index.js")
      }
      if (source === "@npmcli/arborist") return path.join(__dirname, "src/shims/native-package-manager.browser.ts")
      if (
        source === "@opencode/util/npm-config" ||
        (importer === path.join(root, "packages/util/src/npm.ts") && source === "./npm-config.js")
      )
        return path.join(__dirname, "src/shims/npm-config.browser.ts")
      if (importer && /^\.\.?\//.test(source)) {
        const file = path.resolve(path.dirname(importer.split("?")[0]), source).replace(/\.js$/, ".ts")
        if (file === path.join(root, "packages/core/src/effect/websocket-constructor.ts"))
          return path.join(__dirname, "src/shims/websocket-constructor.browser.ts")
        if (file === path.join(root, "packages/core/src/image/photon.ts"))
          return path.join(__dirname, "src/shims/image.browser.ts")
        if (file === path.join(root, "packages/util/src/npm-config.ts"))
          return path.join(__dirname, "src/shims/npm-config.browser.ts")
      }
      if (source === "@opencode/util/no-timeout-fetch") return path.join(__dirname, "src/api-fetch.ts")
      if (/^@effect\/platform-node\/(NodeFileSystem|NodePath|NodeChildProcessSpawner)$/.test(source))
        return path.join(__dirname, "src/shims/effect-platform-node.browser.ts")
      if (!importer?.startsWith(opentui)) return
      const name = source.replace(/^node:/, "")
      if (!names.includes(name)) return
      return path.join(shims, `${name === "fs/promises" ? "fs-promises" : name}.ts`)
    },
  }
}

function transform(): Plugin {
  return {
    name: "opentui-solid",
    enforce: "pre",
    load(id) {
      const source = id.split("?")[0]
      if (/\.(md|txt)$/.test(source) && !id.includes("?url"))
        return { code: "export default " + JSON.stringify(readFileSync(source, "utf8")), map: null }
    },
    async transform(code, id) {
      if (!/\.[jt]sx$/.test(id.split("?")[0])) return
      const result = await transformAsync(code.replace(/\/\*\*?\s*@jsxImportSource[^*]*\*\//g, ""), {
        filename: id,
        presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], typescript],
        sourceMaps: true,
      })
      return { code: result?.code ?? code, map: result?.map }
    },
  }
}

function snapshot(models: unknown): Plugin {
  const id = "\0opencode-model-catalog"
  return {
    name: "opencode-official-model-snapshot",
    enforce: "pre",
    resolveId(source) {
      if (source === "virtual:opencode-model-catalog") return id
    },
    load(source) {
      if (source === id) return "export default " + JSON.stringify(JSON.stringify(models))
    },
    transform(code, source) {
      if (source.split("?")[0] !== path.join(root, "packages/core/src/models-dev.ts")) return
      const marker = 'import snapshotText from "./models-dev/snapshot.txt" with { type: "text" }'
      if (!code.includes(marker)) this.error("OpenCode's catalog snapshot integration changed")
      return {
        code: code.replace(marker, 'import snapshotText from "virtual:opencode-model-catalog"'),
        map: null,
      }
    },
  }
}

function assets(catalog: { source: string; etag: string | null; fetchedAt: string }): Plugin {
  const files = ["opentui.wasm", "parser.worker.browser.js", "tree-sitter.wasm", "assets"]
  const dist = path.join(core, "dist")
  return {
    name: "opentui-browser-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = (request.url ?? "").split("?")[0].replace(/^.*\/opentui\//, "")
        if (!files.some((file) => name === file || name.startsWith(`${file}/`))) return next()
        const file = path.resolve(dist, name)
        if (!file.startsWith(`${dist}/`) || !existsSync(file)) return next()
        response.setHeader(
          "Content-Type",
          file.endsWith(".wasm")
            ? "application/wasm"
            : file.endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream",
        )
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: ".nojekyll", source: "" })
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({
          opencode: version,
          opentui: runtime.version,
          upstream: runtime.upstream,
          renderer: runtime.ref,
        }),
      })
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: JSON.stringify({
          release: runtime.opencode,
          upstream: runtime.upstream,
          commit: process.env.GITHUB_SHA ?? null,
          opentui: { version: runtime.version, commit: runtime.ref },
          host: runtime.host,
          catalog,
        }),
      })
    },
    async writeBundle() {
      await Promise.all(
        files.map((file) => cp(path.join(dist, file), path.join(__dirname, "dist/opentui", file), { recursive: true })),
      )
    },
  }
}

export default defineConfig(async () => {
  const source = "https://models.opencode.ai/api.json"
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error("Unable to bundle the official model catalog: HTTP " + response.status)
  const models = (await response.json()) as Record<string, { models: Record<string, unknown> }>
  if (
    !Object.keys(models).length ||
    !Object.values(models).every((provider) => provider && typeof provider.models === "object")
  )
    throw new Error("The official model catalog has an invalid provider format")
  const catalog = { source, etag: response.headers.get("etag"), fetchedAt: new Date().toISOString() }
  const shim = (name: string) => path.join(__dirname, `src/shims/${name}.browser.ts`)
  const aliases = {
    bun: "bun",
    "bun:bundle": "bun-bundle",
    "bun:sqlite": "bun-sqlite",
    "bun:ffi": "bun-ffi",
    diagnostics_channel: "diagnostics-channel",
    perf_hooks: "perf-hooks",
    path: "path",
    fs: "fs-sync",
    "fs/promises": "fs",
    os: "os",
    child_process: "child-process",
    async_hooks: "async-hooks",
    module: "module",
    v8: "v8",
    net: "net",
    readline: "readline",
    "timers/promises": "timers-promises",
    "stream/promises": "stream-promises",
    "stream/consumers": "stream-consumers",
    glob: "glob",
    "xdg-basedir": "xdg",
    clipboardy: "clipboard",
    open: "open",
    "@parcel/watcher": "watcher",
    "@effect/platform-node": "effect-platform-node",
  }
  return {
    root: __dirname,
    base: process.env.BASE_PATH ?? "./",
    plugins: [
      platform(),
      transform(),
      snapshot(models),
      nodePolyfills({
        include: [
          "util",
          "stream",
          "events",
          "buffer",
          "url",
          "string_decoder",
          "querystring",
          "crypto",
          "assert",
          "http",
          "https",
          "tls",
          "zlib",
          "tty",
          "vm",
          "constants",
        ],
        globals: { Buffer: true, global: true, process: false },
      }),
      assets(catalog),
    ],
    define: {
      OPENCODE_VERSION: JSON.stringify(version),
      OPENTUI_VERSION: JSON.stringify(runtime.version),
      OPENCODE_CHANNEL: JSON.stringify("browser"),
    },
    resolve: {
      dedupe: ["solid-js"],
      alias: [
        ...exports("core"),
        ...exports("solid"),
        ...exports("keymap"),
        { find: /^solid-js(\/.*)?$/, replacement: path.join(__dirname, "node_modules/solid-js$1") },
        { find: /^#sqlite$/, replacement: shim("sqlite") },
        { find: /^#fff$/, replacement: path.join(root, "packages/core/src/filesystem/fff.workerd.ts") },
        { find: /^bun-pty$/, replacement: shim("pty") },
        { find: /^node-fetch$/, replacement: shim("fetch") },
        { find: /^(node:)?process$/, replacement: path.join(shims, "process.ts") },
        { find: /^(node:)?path\/win32$/, replacement: path.join(__dirname, "node_modules/path-win32/index.js") },
        { find: /^@aws-sdk\/credential-providers$/, replacement: shim("aws-credentials") },
        { find: /^@effect\/platform-node\/NodePath$/, replacement: shim("effect-platform-node") },
        ...Object.entries(aliases).flatMap(([name, file]) => [
          { find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: shim(file) },
          ...(!name.includes(":") && !name.startsWith("@")
            ? [{ find: new RegExp(`^node:${name}$`), replacement: shim(file) }]
            : []),
        ]),
      ],
      conditions: ["browser", "workerd", "import", "default"],
    },
    optimizeDeps: {
      include: ["@xterm/xterm", "@xterm/addon-fit", "semver", "yaml", "js-yaml", "path-browserify", "path-win32"],
      exclude: [
        "@opentui/core",
        "@opentui/core/browser",
        "@opentui/solid",
        "@opentui/keymap",
        "opentui-spinner",
        "opentui-spinner/solid",
      ],
    },
    build: {
      target: "esnext",
      outDir: "dist",
      sourcemap: true,
      chunkSizeWarningLimit: 1800,
      commonjsOptions: { requireReturnsDefault: (id) => (id === shim("fs-sync") ? "preferred" : false) },
      rollupOptions: {
        preserveEntrySignatures: "exports-only",
        input: process.env.BROWSER_QA
          ? {
              index: path.join(__dirname, "index.html"),
              runtime: path.join(__dirname, "src/runtime.ts"),
              checks: path.join(__dirname, "backend-smoke.html"),
              embed: path.join(__dirname, "embed-smoke.html"),
            }
          : { index: path.join(__dirname, "index.html"), runtime: path.join(__dirname, "src/runtime.ts") },
        output: { entryFileNames: (chunk) => chunk.isEntry && chunk.name === "runtime" ? "runtime.js" : "assets/[name]-[hash].js" },
      },
    },
    server: { port: 5199, fs: { allow: [root, opentui] } },
    preview: { cors: true },
  }
})
