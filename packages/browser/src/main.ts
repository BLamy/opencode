import "./styles/terminal.css"
import { mountOpenCodeTui } from "./tui-bootstrap"
import { seedDemoProject } from "./seed-project"
import { mountConnectionDialog } from "./connection-dialog"

declare const OPENCODE_VERSION: string
declare const OPENTUI_VERSION: string

const container = document.querySelector<HTMLElement>("#terminal-container")!
const status = document.querySelector<HTMLElement>("#session-info")!
const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.embed = String(params.has("embed"))
document.querySelector<HTMLElement>("#version")!.textContent = `v${OPENCODE_VERSION} · OpenTUI ${OPENTUI_VERSION}`

seedDemoProject()
const url = params.get("server")
if (!url) {
  const disposeConnection = mountConnectionDialog()
  window.addEventListener("pagehide", disposeConnection, { once: true })
}
mountOpenCodeTui({
  container,
  ...(url ? { server: { url: new URL(url).href } } : {}),
})
  .then((session) => {
    document.querySelector<HTMLElement>("#storage-status")!.hidden = session.storage !== "memory"
    status.textContent = url ? "Connected to " + new URL(url).host : "Running locally · WebAssembly"
    container.dataset.state = "ready"
    window.parent.postMessage({ type: "opencode:ready", version: OPENCODE_VERSION, storage: session.storage }, "*")
    window.addEventListener("pagehide", session.dispose, { once: true })
    session.exited.catch(fail)
  })
  .catch(fail)

function fail(error: unknown) {
  console.error("[opencode-browser]", error)
  status.textContent = "Failed to start"
  container.dataset.state = "error"
  const message = document.createElement("pre")
  message.textContent = error instanceof Error ? error.message : String(error)
  container.replaceChildren(message)
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "BROWSER_DATABASE_UPGRADE_REQUIRED" &&
    "originalSnapshot" in error &&
    error.originalSnapshot instanceof Uint8Array
  ) {
    const snapshot = error.originalSnapshot
    const button = document.createElement("button")
    button.textContent = "Download database backup"
    button.addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(snapshot).buffer], { type: "application/vnd.sqlite3" }))
      const link = document.createElement("a")
      link.href = url
      link.download = "opencode-browser-backup.sqlite"
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
    container.append(button)
  }
}
