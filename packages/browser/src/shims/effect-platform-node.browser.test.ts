import { expect, test } from "bun:test"
import { Effect, FileSystem, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { PassThrough } from "stream"
import { NodeChildProcessSpawner, NodeFileSystem, NodeSink, NodeStream } from "./effect-platform-node.browser"

test("scoped virtual files support chunked reads, seeking, writes, and EOF", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/workspace/effect-adapter.txt", "abcdef")
      const file = yield* fs.open("/workspace/effect-adapter.txt", { flag: "r+" })
      const first = yield* file.readAlloc(2)
      yield* file.seek(4, "start")
      yield* file.writeAll(new TextEncoder().encode("XY"))
      const eof = yield* file.readAlloc(2)
      yield* file.seek(0, "start")
      const text = yield* Stream.mkString(
        Stream.decodeText(fs.stream("/workspace/effect-adapter.txt", { chunkSize: 2 })),
      )
      yield* Stream.run(Stream.make(new TextEncoder().encode("next")), fs.sink("/workspace/effect-sink.txt"))
      return { first, eof, text, sink: yield* fs.readFileString("/workspace/effect-sink.txt") }
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  )
  expect(Option.getOrThrow(result.first)).toEqual(new TextEncoder().encode("ab"))
  expect(Option.isNone(result.eof)).toBe(true)
  expect(result.text).toBe("abcdXY")
  expect(result.sink).toBe("next")
})

test("process service dispatches actual browser VFS commands", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* fs.writeFileString("/workspace/effect-process.txt", "from the VFS")
      const process = yield* spawner.spawn(ChildProcess.make("cat", ["effect-process.txt"], { cwd: "/workspace" }))
      return {
        stdout: yield* Stream.mkString(Stream.decodeText(process.stdout)),
        code: Number(yield* process.exitCode),
        running: yield* process.isRunning,
      }
    }).pipe(Effect.scoped, Effect.provide([NodeFileSystem.layer, NodeChildProcessSpawner.layer])),
  )
  expect(result).toEqual({ stdout: "from the VFS", code: 0, running: false })
})

test("stream adapters forward bytes and finish writable streams", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  input.end("streamed bytes")
  const read = Stream.mkString(Stream.decodeText(NodeStream.fromReadable({ evaluate: () => output, onError: String })))
  const write = Stream.run(
    NodeStream.fromReadable({ evaluate: () => input, onError: String }),
    NodeSink.fromWritable({ evaluate: () => output, onError: String, endOnDone: true }),
  )
  const result = await Effect.runPromise(Effect.all([read, write], { concurrency: "unbounded" }))
  expect(result[0]).toBe("streamed bytes")
  expect(output.writableFinished).toBe(true)
})
