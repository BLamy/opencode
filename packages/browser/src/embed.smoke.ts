const frame = document.querySelector<HTMLIFrameElement>("iframe")!
const result = document.querySelector<HTMLElement>("#result")!
const timeout = setTimeout(() => {
  document.body.dataset.state = "fail"
  result.textContent = "The isolated terminal did not finish startup."
}, 30000)

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    event.source !== frame.contentWindow ||
    !event.data ||
    typeof event.data !== "object" ||
    !("type" in event.data) ||
    event.data.type !== "opencode:ready"
  )
    return
  clearTimeout(timeout)
  const passed = event.origin === "null" && "storage" in event.data && event.data.storage === "memory"
  document.body.dataset.state = passed ? "pass" : "fail"
  result.textContent = passed
    ? "Passed: real OpenCode TUI started in an opaque iframe with memory-only SQLite."
    : "The frame reported an unexpected origin or storage mode."
})
