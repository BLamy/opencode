import { loadBrowserRenderLib } from "@opentui/core/browser"

// Install process/Buffer and the native WASM backend before evaluating app
// dependencies, including Node-compatible streams used by the terminal host.
const base = new URL("opentui/", document.baseURI)
loadBrowserRenderLib({
  wasm: new URL("opentui.wasm", base),
  assets: {
    treeSitterWasm: new URL("tree-sitter.wasm", base).href,
    treeSitterWorker: new URL("parser.worker.browser.js", base).href,
    treeSitterAssetBase: base.href,
  },
})
  .then(() => import("./main"))
  .catch((error: unknown) => {
    console.error("[opencode-browser]", error)
    document.querySelector("#session-info")!.textContent = "Failed to start"
    const container = document.querySelector<HTMLElement>("#terminal-container")!
    container.dataset.state = "error"
    container.textContent = error instanceof Error ? error.message : String(error)
  })
