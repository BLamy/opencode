import { expect, test } from "bun:test"
import { readFile, withWorkspaceBridgeScope, writeFile } from "./fs.browser"
import type { BrowserWorkspaceBridge } from "./fs.browser"

test("workspace tools share host files while OpenCode state stays private", async () => {
  const files = new Map<string, string>()
  const bridge: BrowserWorkspaceBridge = {
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path),
    writeFile: (path, content) => { files.set(path, content) },
    mkdir: () => {},
    readdir: () => [],
    stat: () => undefined,
  }
  await withWorkspaceBridgeScope(bridge, async () => {
    await writeFile("/workspaces/bridge-test/index.html", "host app")
    await writeFile("/opencode/config/bridge-private.txt", "private state")
    expect(await readFile("/workspaces/bridge-test/index.html", "utf8")).toBe("host app")
    expect(await readFile("/opencode/config/bridge-private.txt", "utf8")).toBe("private state")
  }, { root: "/workspaces/bridge-test" })
  expect(files.get("/workspaces/bridge-test/index.html")).toBe("host app")
  expect(files.has("/opencode/config/bridge-private.txt")).toBe(false)
})
