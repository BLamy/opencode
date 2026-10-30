import { expect, test } from "bun:test"
import fs from "./fs-sync.browser"
import { channel, tracingChannel } from "./diagnostics-channel.browser"

test("virtual callback filesystem supports exclusive lock directories and timestamp refresh", async () => {
  const root = "/platform-fs-check"
  fs.mkdirSync(root, { recursive: true })
  await new Promise<void>((resolve, reject) => fs.mkdir(root + "/lock", (error) => (error ? reject(error) : resolve())))
  expect(() => fs.mkdirSync(root + "/lock")).toThrow("EEXIST")
  const timestamp = new Date(1710000000123)
  fs.utimesSync(root + "/lock", timestamp, timestamp)
  expect(fs.statSync(root + "/lock").mtimeMs).toBe(timestamp.getTime())
  await new Promise<void>((resolve, reject) => fs.rmdir(root + "/lock", (error) => (error ? reject(error) : resolve())))
  expect(fs.existsSync(root + "/lock")).toBe(false)
  fs.rmSync(root, { recursive: true })
})

test("virtual callback filesystem returns actual files and refuses nonempty directory removal", async () => {
  fs.mkdirSync("/platform-fs-data", { recursive: true })
  fs.writeFileSync("/platform-fs-data/input", "content")
  const value = await new Promise<string | Buffer | undefined>((resolve, reject) =>
    fs.readFile("/platform-fs-data/input", "utf8", (error, result) => (error ? reject(error) : resolve(result))),
  )
  expect(value).toBe("content")
  expect(() => fs.rmdirSync("/platform-fs-data")).toThrow("ENOTEMPTY")
  fs.rmSync("/platform-fs-data", { recursive: true })
  expect(fs.existsSync("/platform-fs-data/input")).toBe(false)
})

test("diagnostics tracing shares channels and propagates results and errors", async () => {
  const trace = tracingChannel("platform-check")
  const phases: string[] = []
  const start = (context: unknown) => {
    phases.push("start")
    expect(context).toEqual({})
  }
  const end = () => {
    phases.push("end")
  }
  trace.subscribe({ start, end })
  expect(channel("tracing:platform-check:start")).toBe(trace.start)
  expect(trace.traceSync(() => 42)).toBe(42)
  expect(phases).toEqual(["start", "end"])
  trace.unsubscribe({ start, end })
  const failure = new Error("failed operation")
  const context: Record<string, unknown> = {}
  await expect(trace.tracePromise(() => Promise.reject(failure), context)).rejects.toBe(failure)
  expect(context.error).toBe(failure)
  expect(trace.hasSubscribers).toBe(false)
})
