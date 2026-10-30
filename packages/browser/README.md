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
bun run test
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
  sandbox="allow-scripts"
  style="width:100%;height:640px;border:0"
  allow="clipboard-read; clipboard-write"
></iframe>
<a href="https://blamy.github.io/opencode/" target="_blank" rel="noopener noreferrer">Open full demo to connect</a>
```

The `embed` query hides the version header and keeps a compact Connection control. The renderer uses a single-threaded WASM runtime, so the frame does not require cross-origin isolation. A sandbox with only `allow-scripts` has an opaque origin and runs real SQLite in memory; a visible “Memory-only storage” notice explains that its sessions last until the frame closes. IndexedDB's `SecurityError` selects the same mode. Quota, corruption, and migration errors remain errors, and existing saved databases are preserved.

The frame emits `{ type: "opencode:ready", version, storage }` after mounting. For an opaque frame, validate `event.source` against that iframe's `contentWindow`; its `event.origin` is `"null"`. For ordinary frames, also validate the expected origin. Top-level browsing retains IndexedDB persistence and the safe legacy upgrade path.

For an AlmostNode host, import `mountOpenCodeTui` from `src/tui-bootstrap.ts`, pass a container plus its `workspaceBridge` and `processBridge`, and call `dispose()` when unmounting. Real SDK responses and streaming events stay within the page's embedded handler. An optional `server` option (or `?server=https://…`) can attach the same TUI to an existing compatible server.

Provider requests use the actual OpenCode provider implementations. Configure credentials through OpenCode's connection UI; API requests are not made by startup tests. The connection dialog routes device authorization, token refresh, and provider requests through the chosen Tailscale exit node or Cloudflare CORS proxy. Native AWS credential profiles need a host credential provider; browser hosts can supply explicit credentials or a Bedrock bearer token.

The `Browser and GitHub Pages` workflow builds the pinned runtime, tests SQLite and platform services, and deploys the complete static application. Native workflows and the browser build share the current Core, Server, SDK, and TUI source.

## OpenTUI spinner compatibility

`opentui-spinner@0.0.7` still targets OpenTUI 0.3. The tracked Bun patch migrates its frame encoding to an `OptimizedBuffer` owned by the renderer's native scene, releases its Unicode frames and buffer on destruction, and treats timer `unref()` as optional in browsers. This keeps the real loading animation active during message submission on both native and WASM renderers.

The Pages workflow runs `packages/tui/test/cli/tui/spinner.test.ts` against the installed OpenTUI 0.8 renderer before deployment. When updating the dependency, retain that regression check until upstream supports the owned Unicode API and browser timer handles.

## Browser connection and device login

The page opens a connection dialog before provider traffic is allowed. You can explore the local workspace offline and reopen the dialog using **Connection**.

- **Private with Tailscale:** the same framework-neutral controller and WASM adapter used by `brett_lamy/ui`, pinned in `src/vendor/tailscale`. Connect this tab interactively, approve the device if your tailnet requires it, and select an online exit node. DNS lookups also travel through the exit node. This path fails closed when disconnected and never falls back to the public proxy. The current Go/WASM fetch buffers response bodies; cancelled requests stop being read, but the underlying Go request may finish in the background.
- **Cloudflare CORS proxy:** explicitly select Brett's existing Worker at `https://bl-cors-proxy.brett-lamy.workers.dev/?url=`. It forwards provider HTTP headers and bodies and preserves streamed responses. Tokens and prompts pass through the relay; its [source](https://github.com/BLamy/ui/blob/67d298b4d0f20cf0ae677036cfbed2d2d4ca55dd/workers/cors-proxy/src/index.ts) does not log or store them. The relay allows `https://blamy.github.io` and local development origins. Some providers, including ChatGPT, may reject requests from Cloudflare’s network even after CORS succeeds. An HTML 403 opens the connection dialog with Tailscale guidance; provider quota and account errors are preserved. Opaque sandbox frames must open the full demo to use it.

After choosing a connection, use `/connect`, **OpenAI**, then **ChatGPT Pro/Plus (headless)**. Complete the device-code approval yourself at the displayed OpenAI URL. OpenCode's existing OAuth plugin handles the exchange and refresh. The native loopback callback method is omitted in the browser build, so device login is the default ChatGPT choice. No shared API key or account token is bundled into the site. Provider credentials and Tailscale node keys remain in the tab's in-memory filesystem/controller, so a reload requires another sign-in. SQLite conversation persistence is separate from credentials.

Vite injects the selected transport lexically into the provider factory and bundled auth plugins. The browser uses HTTP streaming for ChatGPT, with the experimental native WebSocket path disabled. It does not replace global fetch: assets, Tailscale control/DERP traffic, and the embedded HTTP SDK keep their own paths. Native OpenCode continues using its standard network implementation. The browser HTTP handler also installs OpenCode's instance-disposal middleware so models reload immediately after credentials change.

Run `bun run test` for browser storage/platform/transport checks and `BROWSER_QA=1 bun run build` to include `backend-smoke.html`. The compiled smoke page checks real routes, shared SQLite, post-login provider discovery, instance reloads, and SSE without making model requests.

The browser disables the native catalog refresh loop: the complete official snapshot is fetched during every build, so no background catalog request bypasses the selected connection. `bun-ffi-structs` uses the installed OpenTUI WASM pointer backend instead of probing Node's native FFI. A provider's exhausted free/Go allowance ends the request with connection guidance rather than sleeping for a multi-hour `Retry-After`; ordinary transient retry policy and upstream HTTP status codes remain intact.
