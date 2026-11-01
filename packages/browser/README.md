# OpenCode in the browser

This package runs the production OpenCode **v2.2.4 dev** TUI with the fork's **OpenTUI 0.8.0 WebAssembly renderer**. The current Core and Server run in the page through the upstream `ServerFetch.make` embedded HTTP handler, with SQLite compiled to WebAssembly. The standalone v2 database stays in memory because upstream stores provider credentials alongside sessions. No remote OpenCode server is required to boot the interface or use local workspace tools.

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
bun run test
bun run build
bun run preview
```

The build uses relative asset URLs, so the standalone page and public runtime module work at `/opencode/` on GitHub Pages and under other host paths. `BASE_PATH` can override the build base. The build includes the renderer WASM, tree-sitter worker, parser WASM, and syntax assets under `opentui/`; SQLite assets are fingerprinted by Vite.

The browser build lowers modern syntax for Safari, including upstream's `await using` file locks, and installs missing disposal symbols before loading the TUI. On macOS, run `bun run check:safari` after building to parse every generated JavaScript file with Safari's JavaScriptCore. The Pages workflow runs this check on the built artifact before deploying it.

Each build fetches the real catalog from `https://models.opencode.ai/api.json` and includes it through OpenCode's standard model snapshot option so initial provider discovery also works offline. `build-info.json` records the catalog ETag and retrieval time alongside the exact release and runtime commits.

## Embed the actual TUI

```html
<iframe
  src="https://blamy.github.io/opencode/?embed"
  title="OpenCode terminal"
  sandbox="allow-scripts"
  style="width:100%;height:640px;border:0"
  allow="clipboard-read; clipboard-write"
></iframe>
<a href="https://blamy.github.io/opencode/" target="_blank" rel="noopener noreferrer">Open full demo to connect</a>
```

The `embed` query hides the version header and keeps a compact Connection control. The renderer uses a single-threaded WASM runtime, so the frame does not require cross-origin isolation. All standalone frames and the full demo run real SQLite in memory. The visible notice explains that sessions and provider credentials are cleared on reload. The saved v1 IndexedDB database is preserved without being opened or migrated by v2.

The frame emits `{ type: "opencode:ready", version, storage }` after mounting. For an opaque frame, validate `event.source` against that iframe's `contentWindow`; its `event.origin` is `"null"`. For ordinary frames, also validate the expected origin. Top-level browsing uses the same memory-only credential boundary.

The build also publishes `runtime.js`, a stable ES module for a host application:

```ts
const { mount, version } = await import("https://blamy.github.io/opencode/runtime.js")
const session = await mount({
  container: terminalElement,
  connectionContainer: toolbarElement,
  directory: host.directory,
  workspaceBridge: host.workspaceBridge,
  processBridge: host.processBridge,
})
// On unmount:
session.dispose()
```

`@brett_lamy/ui/opencode` supplies the React component and `createAlmostNodeOpenCodeHost` / `createAgentWasmOpenCodeHost` adapters. HTTP app ports use AlmostNode's unchanged service worker and the same container's `ServerBridge`. The isolated preview frame receives a MessagePort connected to the host; app responses stay in the browser. The preview worker/bootstrap source lives in the UI fork's `workers/cors-proxy` directory. One embedded OpenCode runtime can run per document because upstream uses document-wide terminal state.

`runtime.js` advertises `capabilities.hostMcp: 1`. Pass `mcpServers` to `mount()` to attach trusted host implementations to the upstream MCP client. Each `BrowserMcpServer` supplies a unique `name`, `version: "1"`, `tools`, optional `instructions`, and `callTool(name, args, signal)`. The in-page transport performs the MCP initialize/tools-list/tool-call handshake, exposes the catalog through OpenCode's ordinary tool registry, forwards trusted host instructions to the model, and aborts pending calls when the backend closes. It does not send MCP traffic through the provider relay. An external server supplied with `server` owns its own MCP setup.

Vibecoder uses this capability for its `agent-browser` iframe adapter: a supported subset of the [Agent Browser MCP surface](https://github.com/vercel-labs/agent-browser), implemented with DOM events inside the live app. The native Rust/CDP binary cannot run in this WASM runtime. The UI package owns snapshot refs, input/actions and restricted navigation. App HTML reaches the iframe through the unchanged AlmostNode service worker, with the automation script added by the host response bridge. See the UI OpenCode documentation for supported tools and limitations.

Workspace files go through the supplied bridge; `/opencode/*` private state stays in the in-memory VFS. Application assets use the browser transport saved by AlmostNode before it installs its legacy global fetch wrapper. Provider requests still require the explicit Connection choice.

For source integrations, import `mountOpenCodeTui` from `src/tui-bootstrap.ts` and call `dispose()` when unmounting. Real SDK responses and streaming events stay within the page's embedded handler. An optional `server` option (or `?server=https://…`) can attach the same TUI to an existing compatible server.

Provider requests use the actual OpenCode provider implementations. Configure credentials through OpenCode's connection UI; API requests are not made by startup tests. The connection dialog routes device authorization, token refresh, and provider requests through the chosen Tailscale exit node or Cloudflare CORS proxy. Native AWS credential profiles need a host credential provider; browser hosts can supply explicit credentials or a Bedrock bearer token.

The `Browser and GitHub Pages` workflow builds the pinned runtime, tests SQLite and platform services, and deploys the complete static application. Native workflows and the browser build share the current Core, Server, SDK, and TUI source.

## Upstream v2 runtime

The source is pinned to upstream `dev` at `ad711440548abaf6eb7f329f72bbce8357a11c2f`, version 2.2.4. The browser adapter uses v2's public embedded-server entry point and TUI terminal-handoff interface. V2 supplies its own OpenTUI 0.8 spinner; the incompatible v1 `opentui-spinner` dependency is no longer involved.

The browser backend replaces the database, filesystem, command spawner, and provider HTTP client through the upstream service graph. HTTP API calls stay in the page; assets and Tailscale control traffic use the browser network independently. Built-in plugins are bundled. Installing external runtime plugins and native packages requires an explicit host capability.

## Browser connection and device login

The page opens a connection dialog before provider traffic is allowed. You can explore the local workspace offline and reopen the dialog using **Connection**.

- **Private with Tailscale:** the same framework-neutral controller and WASM adapter used by `brett_lamy/ui`, pinned in `src/vendor/tailscale`. Connect this tab interactively, approve the device if your tailnet requires it, and select an online exit node. DNS lookups also travel through the exit node. This path fails closed when disconnected and never falls back to the public proxy. The current Go/WASM fetch buffers response bodies; cancelled requests stop being read, but the underlying Go request may finish in the background.
- **Cloudflare CORS proxy:** explicitly select Brett's existing Worker at `https://bl-cors-proxy.brett-lamy.workers.dev/?url=`. It forwards provider HTTP headers and bodies and preserves streamed responses. Tokens and prompts pass through the relay; its [source](https://github.com/BLamy/ui/blob/67d298b4d0f20cf0ae677036cfbed2d2d4ca55dd/workers/cors-proxy/src/index.ts) does not log or store them. The relay allows `https://blamy.github.io` and local development origins. Some providers, including ChatGPT, may reject requests from Cloudflare’s network even after CORS succeeds. An HTML 403 opens the connection dialog with Tailscale guidance; provider quota and account errors are preserved. Opaque sandbox frames must open the full demo to use it.

After choosing a connection, use `/connect`, **OpenAI**, then **Codex device code (legacy)**. Complete the device-code approval yourself at the displayed OpenAI URL. OpenCode's existing OAuth plugin handles the exchange and refresh. The native loopback callback method is omitted in the browser build, so device login is the default ChatGPT choice. No shared API key or account token is bundled into the site. Provider credentials, conversations, and Tailscale node keys remain in this tab's in-memory SQLite/controller, so a reload requires another sign-in.

The selected provider transport is injected into the v2 HTTP client and the bundled OAuth implementations. OpenAI uses HTTP with uncompressed request bodies in the browser. The native loopback auth method is omitted; the built-in device method remains available. Global fetch is not replaced. Upstream's credential events reload the provider after connection changes.

Run `bun run test` for browser storage/platform/transport checks and `BROWSER_QA=1 bun run build` to include `backend-smoke.html`. The compiled smoke page checks real routes, shared SQLite, v2 model discovery, device-method registration, actual workspace bytes, session creation, host MCP discovery/instructions, and a real MCP client call that clicks a test DOM button without making model requests.

The browser disables the native catalog refresh loop: the complete official snapshot is fetched during every build, so no background catalog request bypasses the selected connection. `bun-ffi-structs` uses the installed OpenTUI WASM pointer backend instead of probing Node's native FFI. V2 classifies exhausted free/Go allowance as a terminal quota error. Temporary rate limits retain the upstream retry policy and HTTP diagnostics.
