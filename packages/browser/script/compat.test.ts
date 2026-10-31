import { expect, test } from "bun:test"
import { transformWithEsbuild } from "vite"
import { browserTarget } from "./compat"
import { installDisposalSymbols } from "../src/shims/disposable.browser"

test("browser output releases await-using leases when Safari has no disposal symbols", async () => {
  const output = await transformWithEsbuild(
    `return async function run(fail) {
      const events = []
      const lease = { [Symbol.asyncDispose]: async () => { events.push("released") } }
      try {
        await using C = lease
        events.push("acquired")
        if (fail) throw new Error("operation failed")
        events.push("completed")
      } catch (error) {
        events.push(error.message)
      }
      return events
    }`,
    "lease.js",
    { target: browserTarget },
  )
  // A separate Symbol facade reproduces Safari without changing the test host.
  const symbols = { for: Symbol.for }
  installDisposalSymbols(symbols)
  installDisposalSymbols(symbols)
  const run = new Function("Symbol", output.code)(symbols) as (fail: boolean) => Promise<string[]>
  expect(await run(false)).toEqual(["acquired", "completed", "released"])
  expect(await run(true)).toEqual(["acquired", "released", "operation failed"])
})

test("browser disposal retains an engine's native well-known symbols", () => {
  const symbols = { for: Symbol.for, dispose: Symbol("native dispose"), asyncDispose: Symbol("native asyncDispose") }
  const original = { ...symbols }
  installDisposalSymbols(symbols)
  expect(symbols).toEqual(original)
})
