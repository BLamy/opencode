# OpenCode in the browser

This package runs the production OpenCode **v1.19.5** TUI with the fork's **OpenTUI 0.8.0 WebAssembly renderer**. The current Core and Server run in the page through Effect's embedded HTTP handler, with SQLite compiled to WebAssembly and persisted in IndexedDB. No remote OpenCode server is required to boot the interface or use local workspace tools.

The workspace and process interfaces in `src/shims/fs.browser.ts` and `src/shims/child-process.browser.ts` let AlmostNode supply its real filesystem, shell, and package manager. The standalone page provides an in-memory sample workspace and the supported local commands. Commands that need a host fail with a descriptive error when no process bridge is supplied.

The current AlmostNode fork is published as `@agent-wasm/core@0.4.0`, recorded in `opentui.json`. A host adapter supplies synchronous workspace reads/writes/stat/directory operations and asynchronous `exec({ command, args, cwd, env, stdin, shell, signal })` returning its actual stdout, stderr, and exit code. Workspace roots are registered separately so concurrent sandboxes route to their own filesystem and process bridge. The standalone page does not bundle another shell runtime; installing npm packages, native subprocesses, and PTYs requires the corresponding host capability.

## Build and run

Use Bun from the root `package.json`, Zig 0.16.0, and the fork revision recorded in [opentui.json](./opentui.json). Place the OpenTUI checkout at `vendor/opentui` or beside this repository, or set `OPENTUI_DIR` to its path.

```sh
bun install --frozen-lockfile
cd vendor/opentui
bun install --frozen-lockfile
bun run --cwd packages/core build:wasm
bun run --cwd packages/core build:lib
cd ../../packages/browser
bun test
bun run build
bun run preview
```

The default base path is `/opencode/`, matching GitHub Pages. Set `BASE_PATH=/` to serve at the origin root. The build includes the renderer WASM, tree-sitter worker, parser WASM, and syntax assets under `opentui/`; SQLite assets are fingerprinted by Vite.

Each build fetches the real catalog from `https://models.opencode.ai/api.json` and includes it through OpenCode's standard model snapshot option so initial provider discovery also works offline. `build-info.json` records the catalog ETag and retrieval time alongside the exact release and runtime commits.

## Embed the actual TUI

```html
<iframe
  src="https://blamy.github.io/opencode/?embed"
  title="OpenCode terminal"
  style="width:100%;height:640px;border:0"
  allow="clipboard-read; clipboard-write"
></iframe>
```

The `embed` query removes the host header. The renderer uses a single-threaded WASM runtime, so the frame does not require cross-origin isolation. The frame emits `{ type: "opencode:ready", version }` after mounting; hosts should validate `event.origin` before handling it.

For an AlmostNode host, import `mountOpenCodeTui` from `src/tui-bootstrap.ts`, pass a container plus its `workspaceBridge` and `processBridge`, and call `dispose()` when unmounting. Real SDK responses and streaming events stay within the page's embedded handler. An optional `server` option (or `?server=https://…`) can attach the same TUI to an existing compatible server.

Provider requests use the actual OpenCode provider implementations. Configure credentials through OpenCode's connection UI; API requests are not made by startup tests. Providers must permit browser requests or be accessed through a user-controlled gateway. Native AWS credential profiles need a host credential provider; browser hosts can supply explicit credentials or a Bedrock bearer token.

The `Browser and GitHub Pages` workflow builds the pinned runtime, tests SQLite and platform services, and deploys the complete static application. Native workflows and the browser build share the current Core, Server, SDK, and TUI source.
