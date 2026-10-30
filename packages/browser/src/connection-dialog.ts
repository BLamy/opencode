import { getProviderConnection, onProviderConnection, setProviderConnection } from "./provider-network"
import type { Tailscale } from "./vendor/tailscale/tailscale"

export function mountConnectionDialog() {
  const dialog = document.createElement("dialog")
  dialog.id = "connection-dialog"
  dialog.setAttribute("aria-labelledby", "connection-title")
  dialog.setAttribute("aria-describedby", "connection-description")
  dialog.innerHTML = `
    <div class="connection-heading">
      <span class="connection-eyebrow">OPENCODE / BROWSER NETWORKING</span>
      <button type="button" class="connection-close" aria-label="Close connection settings">×</button>
    </div>
    <h1 id="connection-title">Choose how OpenCode connects</h1>
    <p id="connection-description">Model APIs block direct browser requests with CORS. Choose a connection for device sign-in, token refresh, and AI messages.</p>
    <div class="connection-options">
      <section class="connection-option" aria-labelledby="private-title">
        <span class="connection-tag">YOUR NETWORK</span>
        <h2 id="private-title">Private with Tailscale</h2>
        <p>Connect this tab to your tailnet and choose an online exit node. Provider requests travel through that device; the public CORS proxy is not used.</p>
        <p class="connection-detail">Requires an exit node you control. This WASM transport buffers replies before displaying them. Node keys stay in this tab.</p>
        <button type="button" id="tailscale-sign-in">Connect Tailscale</button>
        <a id="tailscale-login" hidden target="_blank" rel="noopener noreferrer">Open Tailscale sign-in</a>
        <div id="tailscale-controls" hidden>
          <label for="tailscale-exit">Exit node</label>
          <select id="tailscale-exit"><option value="">Choose an online exit node</option></select>
          <button type="button" id="tailscale-use" disabled>Use private connection</button>
        </div>
        <p id="tailscale-status" class="connection-detail" role="status" aria-live="polite"></p>
      </section>
      <section class="connection-option" aria-labelledby="proxy-title">
        <span class="connection-tag">QUICK CONNECT</span>
        <h2 id="proxy-title">Cloudflare CORS proxy</h2>
        <p>Use Brett’s Cloudflare Worker to reach providers and stream replies from this page.</p>
        <p class="connection-detail">The relay handles your provider tokens, prompts, and replies in transit. Its code does not log or store them. Choose Tailscale if you prefer to use your own network.</p>
        <code>bl-cors-proxy.brett-lamy.workers.dev</code>
        <button type="button" id="proxy-use">Use Cloudflare proxy</button>
      </section>
    </div>
    <p id="connection-status" role="status" aria-live="polite"></p>
    <footer class="connection-footer">
      <button type="button" class="connection-secondary" id="connection-offline">Explore offline</button>
      <span>Then use <strong>/connect → OpenAI → Codex device code (legacy)</strong>.<br>Provider credentials last for this tab. Reopen this dialog with Connection.</span>
    </footer>`
  document.body.append(dialog)
  const find = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!
  const status = find<HTMLParagraphElement>("#connection-status")
  const privateStatus = find<HTMLParagraphElement>("#tailscale-status")
  const signIn = find<HTMLButtonElement>("#tailscale-sign-in")
  const usePrivate = find<HTMLButtonElement>("#tailscale-use")
  const exit = find<HTMLSelectElement>("#tailscale-exit")
  const button = document.createElement("button")
  button.id = "connection-button"
  button.type = "button"
  button.setAttribute("aria-haspopup", "dialog")
  document.querySelector("#status-bar")!.append(button)
  const open = (event?: Event) => {
    if (!dialog.open) dialog.showModal()
    if (event instanceof CustomEvent && typeof event.detail === "string") status.textContent = event.detail
  }
  const close = () => dialog.close()
  const report = (error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
  const refresh = () => {
    const connection = getProviderConnection()
    button.textContent =
      "Connection: " +
      (connection.type === "proxy" ? "Cloudflare" : connection.type === "tailscale" ? "Tailscale" : "offline")
    status.textContent =
      connection.type === "proxy"
        ? "Cloudflare selected. Sign in with your own provider account to send messages."
        : connection.type === "tailscale"
          ? "Tailscale selected. Requests stop if the exit node disconnects."
          : "No provider requests leave this tab until you choose a connection."
  }
  refresh()
  const unsubscribe = onProviderConnection(refresh)
  let tailscale: Tailscale | undefined
  let unsubscribeTailnet: (() => void) | undefined
  let release: (() => void) | undefined
  let popup: Window | null = null
  const updateTailnet = () => {
    if (!tailscale) return
    const snapshot = tailscale.getSnapshot()
    const selected = exit.value || snapshot.exitNodeId
    const peers = snapshot.peers.filter((peer) => peer.exitNode && peer.id)
    const signature = peers.map((peer) => `${peer.id}:${peer.online}:${peer.name}`).join("|")
    if (exit.dataset.peers !== signature) {
      exit.dataset.peers = signature
      exit.replaceChildren(
        new Option("Choose an online exit node", ""),
        ...peers.map((peer) => {
          const option = new Option(peer.name + (peer.online ? "" : " (offline)"), peer.id!)
          option.disabled = !peer.online
          return option
        }),
      )
      if (selected && peers.some((peer) => peer.id === selected && peer.online)) exit.value = selected
    }
    find("#tailscale-controls").hidden = snapshot.status !== "connected"
    const online = peers.some((peer) => peer.id === exit.value && peer.online)
    usePrivate.disabled = snapshot.status !== "connected" || !online
    const pending = ["loading", "signing-in", "starting", "needs-approval"].includes(snapshot.status)
    signIn.disabled = pending
    signIn.textContent = pending
      ? "Connecting…"
      : snapshot.status === "connected"
        ? "Reconnect Tailscale"
        : "Connect Tailscale"
    privateStatus.textContent =
      snapshot.error?.message ??
      (snapshot.status === "connected"
        ? peers.some((peer) => peer.online)
          ? "Connected. Choose an exit node to carry provider traffic."
          : "Connected, but no exit nodes are online. Enable one in your Tailscale admin console."
        : snapshot.status === "needs-approval"
          ? "Approve this device in your Tailscale admin console."
          : pending
            ? "Finish Tailscale sign-in in the new window."
            : "")
    const login = find<HTMLAnchorElement>("#tailscale-login")
    login.hidden = !snapshot.loginUrl
    if (snapshot.loginUrl) login.href = snapshot.loginUrl
    if (
      getProviderConnection().type === "tailscale" &&
      (snapshot.status !== "connected" ||
        !snapshot.peers.some((peer) => peer.id === snapshot.exitNodeId && peer.exitNode && peer.online))
    ) {
      button.textContent = "Connection: Tailscale disconnected"
      open()
    }
  }
  button.addEventListener("click", open)
  window.addEventListener("opencode:connection-required", open)
  find(".connection-close").addEventListener("click", close)
  find("#connection-offline").addEventListener("click", () => {
    setProviderConnection({ type: "offline" })
    tailscale?.cancel()
    close()
  })
  find("#proxy-use").addEventListener("click", () => {
    if (window.origin === "null") {
      status.textContent = "This sandbox hides its origin. Open the full demo to use the proxy."
      return
    }
    tailscale?.cancel()
    setProviderConnection({ type: "proxy" })
    close()
  })
  exit.addEventListener("change", updateTailnet)
  signIn.addEventListener("click", () => {
    // Preserve the user gesture before lazy imports/downloads; the controller navigates this same popup.
    popup = window.open("about:blank", "opencode-tailscale", "popup,width=560,height=720")
    void (async () => {
      signIn.disabled = true
      privateStatus.textContent = "Loading the Tailscale WASM client…"
      if (!tailscale) {
        const [{ createTailscale }, { createTailscaleConnectClient }, { default: wasmURL }] = await Promise.all([
          import("./vendor/tailscale/tailscale"),
          import("./vendor/tailscale/tailscale-connect"),
          import("@agent-wasm/tailscale-connect/main.wasm?url"),
        ])
        tailscale = createTailscale({
          client: () => createTailscaleConnectClient({ wasmURL, dnsVia: "exit-node" }),
          hostname: "opencode-browser",
          lockName: "opencode-browser",
          autoConnect: false,
          env: { open: () => popup },
        })
        unsubscribeTailnet = tailscale.subscribe(updateTailnet)
        release = tailscale.activate()
      }
      await tailscale.signIn()
      if (tailscale.getSnapshot().status === "connected") popup?.close()
      updateTailnet()
    })().catch((error: unknown) => {
      popup?.close()
      signIn.disabled = false
      privateStatus.textContent = error instanceof Error ? error.message : String(error)
    })
  })
  usePrivate.addEventListener("click", () => {
    const client = tailscale
    if (!client || !exit.value) return
    usePrivate.disabled = true
    void client
      .setExitNode(exit.value)
      .then(() => {
        setProviderConnection({ type: "tailscale", client })
        updateTailnet()
        close()
      })
      .catch(report)
  })
  // location.origin is the URL origin even in an opaque sandbox; window.origin is the actual security origin.
  // A sandbox without popups must use the host preview’s link outside the frame to open the full app.
  if (window.origin === "null") {
    find<HTMLButtonElement>("#proxy-use").disabled = true
    signIn.disabled = true
    const note = document.createElement("p")
    note.className = "connection-detail"
    note.textContent =
      "This sandbox hides its origin and blocks sign-in popups. Use the preview toolbar’s Open demo link, or open https://blamy.github.io/opencode/ in a new tab, to connect."
    find("#proxy-use").after(note)
  }
  open()
  return () => {
    unsubscribe()
    unsubscribeTailnet?.()
    release?.()
    void tailscale?.dispose()
    popup?.close()
    window.removeEventListener("opencode:connection-required", open)
    button.remove()
    dialog.remove()
  }
}
