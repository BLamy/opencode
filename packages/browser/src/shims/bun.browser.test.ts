import { expect, test } from "bun:test"
import BunBrowser, { file, pathToFileURL, stringWidth, stripANSI, write } from "./bun.browser"
import { readFile, rm } from "./fs.browser"

test("Bun state files use the shared browser VFS and report UTF-8 byte counts", async () => {
  const path = "/bun-persistence-check/state.json"
  const source = JSON.stringify({ text: "你好 👨‍👩‍👧‍👦", count: 2 })
  expect(await file(path).exists()).toBe(false)
  expect(await write(pathToFileURL(path), source)).toBe(new TextEncoder().encode(source).byteLength)
  expect(await readFile(path, "utf8")).toBe(source)
  expect(await file(path).json()).toEqual({ text: "你好 👨‍👩‍👧‍👦", count: 2 })
  expect(await file(path).exists()).toBe(true)
  expect(await write(file(path + ".copy"), file(path))).toBe(new TextEncoder().encode(source).byteLength)
  expect(await file(path + ".copy").text()).toBe(source)
  await rm("/bun-persistence-check", { recursive: true })
})

test("Bun file failures remain observable and invalid binary writes preserve existing data", async () => {
  const path = "/bun-persistence-errors/state"
  await expect(file(path).text()).rejects.toMatchObject({ code: "ENOENT" })
  await write(path, "previous")
  await expect(write(path, new Uint8Array([0xff, 0xfe]))).rejects.toBeInstanceOf(TypeError)
  expect(await file(path).text()).toBe("previous")
  await write(path, "invalid JSON")
  await expect(file(path).json()).rejects.toBeInstanceOf(SyntaxError)
  await write(path, new TextEncoder().encode('\ufeff{"ready":true}'))
  expect(await file(path).json()).toEqual({ ready: true })
  await rm("/bun-persistence-errors", { recursive: true })
})

test("terminal width counts display cells across Unicode graphemes and ANSI links", () => {
  expect(stringWidth("你好")).toBe(4)
  expect(stringWidth("e\u0301")).toBe(1)
  expect(stringWidth("👨‍👩‍👧‍👦")).toBe(2)
  expect(stringWidth("a\nb\tc")).toBe(3)
  const link = "\x1b]8;;https://example.com\x07\x1b[31m你好\x1b[0m\x1b]8;;\x07"
  expect(stripANSI(link)).toBe("你好")
  expect(stringWidth(link)).toBe(4)
})

test("importing the browser shim preserves a host's existing native Bun file operations", () => {
  expect(globalThis.Bun.file).not.toBe(BunBrowser.file)
  expect(globalThis.Bun.version).not.toBe("browser")
  expect(BunBrowser.file).toBe(file)
})

test("browser Bun sleep supports the migration overlay without blocking the render", async () => {
  let completed = false
  const pending = BunBrowser.sleep(0).then(() => {
    completed = true
  })
  expect(completed).toBe(false)
  await pending
  expect(completed).toBe(true)
  await BunBrowser.sleep(new Date(0))
})
