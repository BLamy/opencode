import { ByteSize, Effect, Fiber, FileSystem, Layer, Option, Path, Scope, Sink, Stream } from "effect"
import { systemError } from "effect/PlatformError"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Readable, Writable } from "stream"

import * as BrowserFs from "./fs.browser"
import { globSync } from "./glob.browser"
import { matchGlob } from "./glob-utils.browser"
import { runBrowserCommand } from "./child-process.browser"

function toPlatformError(method: string, pathOrDescriptor: string | number, cause?: unknown) {
  const code = typeof cause === "object" && cause && "code" in cause ? String((cause as { code?: unknown }).code) : ""

  return systemError({
    _tag:
      code === "ENOENT"
        ? "NotFound"
        : code === "EEXIST"
          ? "AlreadyExists"
          : ["EACCES", "EPERM"].includes(code)
            ? "PermissionDenied"
            : ["ENOTDIR", "EISDIR"].includes(code)
              ? "BadResource"
              : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor,
    description: cause instanceof Error ? cause.message : undefined,
    cause,
  })
}

function notSupported(method: string, pathOrDescriptor: string | number) {
  return systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor,
    description: "not supported in browser mode",
  })
}

const openBrowserFile = (path: string, options?: { flag?: FileSystem.OpenFlag }) =>
  Effect.gen(function* () {
    const flag = options?.flag ?? "r"
    const exists = BrowserFs._vfs_exists(path)
    if (flag.includes("x") && exists)
      return yield* Effect.fail(
        systemError({ _tag: "AlreadyExists", module: "FileSystem", method: "open", pathOrDescriptor: path }),
      )
    if (flag.startsWith("w") || (flag.startsWith("a") && !exists))
      yield* Effect.tryPromise({
        try: () => BrowserFs.writeFile(path, ""),
        catch: (cause) => toPlatformError("open", path, cause),
      })
    let bytes = yield* Effect.tryPromise({
      try: async () => {
        const content = await BrowserFs.readFile(path)
        return typeof content === "string" ? new TextEncoder().encode(content) : content
      },
      catch: (cause) => toPlatformError("open", path, cause),
    })
    let position = flag.startsWith("a") ? bytes.length : 0
    let closed = false
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
      }),
    )
    const check = () => {
      if (closed) throw new Error("File handle is closed")
    }
    const read = (size: number) => {
      check()
      const chunk = bytes.slice(position, position + size)
      position += chunk.length
      return chunk
    }
    const write = (data: Uint8Array) =>
      Effect.tryPromise({
        try: async () => {
          check()
          if (!flag.includes("+") && !flag.startsWith("a") && !flag.startsWith("w"))
            throw new Error("File handle is read-only")
          if (flag.startsWith("a")) position = bytes.length
          const next = new Uint8Array(Math.max(bytes.length, position + data.length))
          next.set(bytes)
          next.set(data, position)
          await BrowserFs.writeFile(path, next)
          bytes = next
          position += data.length
          return data.length
        },
        catch: (cause) => toPlatformError("write", path, cause),
      })
    return {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: Effect.tryPromise({
        try: async () => toFileInfo(await BrowserFs.stat(path)),
        catch: (cause) => toPlatformError("stat", path, cause),
      }),
      seek: (offset, from) =>
        Effect.sync(() => {
          check()
          position = Math.max(0, (from === "current" ? position : 0) + Number(offset))
          return BigInt(position)
        }),
      sync: Effect.void,
      read: (buffer) =>
        Effect.try({
          try: () => {
            const chunk = read(buffer.length)
            buffer.set(chunk)
            return chunk.length
          },
          catch: (cause) => toPlatformError("read", path, cause),
        }),
      readAlloc: (size) =>
        Effect.try({
          try: () => {
            const chunk = read(Number(size))
            return chunk.length ? Option.some(chunk) : Option.none()
          },
          catch: (cause) => toPlatformError("readAlloc", path, cause),
        }),
      truncate: (length = 0) =>
        Effect.tryPromise({
          try: async () => {
            check()
            const next = new Uint8Array(Number(length))
            next.set(bytes.subarray(0, next.length))
            await BrowserFs.writeFile(path, next)
            bytes = next
          },
          catch: (cause) => toPlatformError("truncate", path, cause),
        }),
      write,
      writeAll: (buffer) => write(buffer).pipe(Effect.asVoid),
    } satisfies FileSystem.File
  })

function toFileInfo(stats: Awaited<ReturnType<typeof BrowserFs.stat>>) {
  return {
    type: stats.isDirectory() ? ("Directory" as const) : ("File" as const),
    mtime: Option.some(stats.mtime),
    atime: Option.some(stats.mtime),
    birthtime: Option.some(stats.mtime),
    dev: 0n,
    ino: Option.none<bigint>(),
    mode: stats.isDirectory() ? 0o755 : 0o644,
    nlink: Option.none<bigint>(),
    uid: Option.none<number>(),
    gid: Option.none<number>(),
    rdev: Option.none<bigint>(),
    size: ByteSize.bytes(stats.size),
    blksize: Option.none<ByteSize.ByteSize>(),
    blocks: Option.none<bigint>(),
  }
}

async function copyRecursive(fromPath: string, toPath: string): Promise<void> {
  const stats = await BrowserFs.stat(fromPath)

  if (stats.isDirectory()) {
    await BrowserFs.mkdir(toPath, { recursive: true })
    const entries = await BrowserFs.readdir(fromPath, { withFileTypes: true })
    for (const entry of entries) {
      const source = `${fromPath.replace(/\/$/, "")}/${entry.name}`
      const target = `${toPath.replace(/\/$/, "")}/${entry.name}`
      if (entry.isDirectory()) {
        await copyRecursive(source, target)
        continue
      }

      const content = await BrowserFs.readFile(source)
      await BrowserFs.writeFile(target, content)
    }
    return
  }

  const content = await BrowserFs.readFile(fromPath)
  await BrowserFs.writeFile(toPath, content)
}

async function readDirectoryRecursive(path: string, prefix = ""): Promise<string[]> {
  const entries = await BrowserFs.readdir(path, { withFileTypes: true })
  const output: string[] = []

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    output.push(relative)

    if (entry.isDirectory()) {
      output.push(...(await readDirectoryRecursive(`${path.replace(/\/$/, "")}/${entry.name}`, relative)))
    }
  }

  return output
}

function browserFileSystemLayer() {
  return Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.make({
      glob: (pattern, options) =>
        Effect.try({
          try: () =>
            globSync(pattern, { cwd: options?.root, dot: true }).filter(
              (file) => !options?.exclude?.some((pattern) => matchGlob(file, pattern, { dot: true })),
            ),
          catch: (cause) => toPlatformError("glob", options?.root ?? "/", cause),
        }),
      lstat: (path) =>
        Effect.tryPromise({
          try: async () => toFileInfo(await BrowserFs.stat(path)),
          catch: (cause) => toPlatformError("lstat", path, cause),
        }),
      access: (path) =>
        Effect.tryPromise({
          try: () => BrowserFs.access(path),
          catch: (cause) => toPlatformError("access", path, cause),
        }),
      chmod: () => Effect.void,
      chown: () => Effect.void,
      copy: (fromPath, toPath) =>
        Effect.tryPromise({
          try: () => copyRecursive(fromPath, toPath),
          catch: (cause) => toPlatformError("copy", fromPath, cause),
        }),
      copyFile: (fromPath, toPath) =>
        Effect.tryPromise({
          try: () => BrowserFs.copyFile(fromPath, toPath),
          catch: (cause) => toPlatformError("copyFile", fromPath, cause),
        }),
      link: (fromPath) => Effect.fail(notSupported("link", fromPath)),
      makeDirectory: (path, options) =>
        Effect.tryPromise({
          try: () => BrowserFs.mkdir(path, options),
          catch: (cause) => toPlatformError("makeDirectory", path, cause),
        }),
      makeTempDirectory: (options) =>
        Effect.tryPromise({
          try: async () => {
            const directory = options?.directory ?? "/tmp"
            const prefix = options?.prefix ?? "opencode-"
            await BrowserFs.mkdir(directory, { recursive: true })
            return BrowserFs.mkdtemp(`${directory.replace(/\/$/, "")}/${prefix}`)
          },
          catch: (cause) => toPlatformError("makeTempDirectory", options?.directory ?? "/tmp", cause),
        }),
      makeTempDirectoryScoped: (options) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const directory = options?.directory ?? "/tmp"
              const prefix = options?.prefix ?? "opencode-"
              await BrowserFs.mkdir(directory, { recursive: true })
              return BrowserFs.mkdtemp(`${directory.replace(/\/$/, "")}/${prefix}`)
            },
            catch: (cause) => toPlatformError("makeTempDirectoryScoped", options?.directory ?? "/tmp", cause),
          }),
          (path) =>
            Effect.tryPromise({
              try: () => BrowserFs.rm(path, { recursive: true, force: true }),
              catch: (cause) => cause,
            }).pipe(Effect.ignore),
        ),
      makeTempFile: (options) =>
        Effect.tryPromise({
          try: async () => {
            const directory = options?.directory ?? "/tmp"
            const prefix = options?.prefix ?? "opencode-"
            const suffix = options?.suffix ?? ""
            await BrowserFs.mkdir(directory, { recursive: true })
            const path = `${directory.replace(/\/$/, "")}/${prefix}${Math.random().toString(36).slice(2, 10)}${suffix}`
            await BrowserFs.writeFile(path, "")
            return path
          },
          catch: (cause) => toPlatformError("makeTempFile", options?.directory ?? "/tmp", cause),
        }),
      makeTempFileScoped: (options) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const directory = options?.directory ?? "/tmp"
              const prefix = options?.prefix ?? "opencode-"
              const suffix = options?.suffix ?? ""
              await BrowserFs.mkdir(directory, { recursive: true })
              const path = `${directory.replace(/\/$/, "")}/${prefix}${Math.random().toString(36).slice(2, 10)}${suffix}`
              await BrowserFs.writeFile(path, "")
              return path
            },
            catch: (cause) => toPlatformError("makeTempFileScoped", options?.directory ?? "/tmp", cause),
          }),
          (path) =>
            Effect.tryPromise({
              try: () => BrowserFs.rm(path, { force: true }),
              catch: (cause) => cause,
            }).pipe(Effect.ignore),
        ),
      open: openBrowserFile,
      readDirectory: (path, options) =>
        Effect.tryPromise({
          try: () =>
            options?.recursive
              ? readDirectoryRecursive(path)
              : BrowserFs.readdir(path).then((entries) => entries as string[]),
          catch: (cause) => toPlatformError("readDirectory", path, cause),
        }),
      readFile: (path) =>
        Effect.tryPromise({
          try: async () => {
            const content = await BrowserFs.readFile(path)
            return typeof content === "string" ? new TextEncoder().encode(content) : content
          },
          catch: (cause) => toPlatformError("readFile", path, cause),
        }),
      readLink: (path) =>
        Effect.tryPromise({
          try: () => BrowserFs.readlink(path),
          catch: (cause) => toPlatformError("readLink", path, cause),
        }),
      realPath: (path) =>
        Effect.tryPromise({
          try: () => BrowserFs.realpath(path),
          catch: (cause) => toPlatformError("realPath", path, cause),
        }),
      remove: (path, options) =>
        Effect.tryPromise({
          try: () => BrowserFs.rm(path, options),
          catch: (cause) => toPlatformError("remove", path, cause),
        }),
      rename: (oldPath, newPath) =>
        Effect.tryPromise({
          try: () => BrowserFs.rename(oldPath, newPath),
          catch: (cause) => toPlatformError("rename", oldPath, cause),
        }),
      stat: (path) =>
        Effect.tryPromise({
          try: async () => toFileInfo(await BrowserFs.stat(path)),
          catch: (cause) => toPlatformError("stat", path, cause),
        }),
      symlink: (fromPath) => Effect.fail(notSupported("symlink", fromPath)),
      truncate: (path, length) =>
        Effect.tryPromise({
          try: async () => {
            const current = await BrowserFs.readFile(path)
            const bytes = typeof current === "string" ? new TextEncoder().encode(current) : current
            const next = bytes.slice(0, length === undefined ? 0 : Number(length))
            await BrowserFs.writeFile(path, next)
          },
          catch: (cause) => toPlatformError("truncate", path, cause),
        }),
      utimes: (path, atime, mtime) =>
        Effect.tryPromise({
          try: () => BrowserFs.utimes(path, atime, mtime),
          catch: (cause) => toPlatformError("utimes", path, cause),
        }),
      watch: () => Stream.empty,
      writeFile: (path, data, options) =>
        Effect.tryPromise({
          try: () => BrowserFs.writeFile(path, data, options),
          catch: (cause) => toPlatformError("writeFile", path, cause),
        }),
    }),
  )
}

function browserChildProcessSpawnerLayer() {
  const spawn = (
    command: ChildProcess.Command,
  ): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError, Scope.Scope> =>
    Effect.gen(function* () {
      if (command._tag === "PipedCommand") {
        if (command.options.to && command.options.to !== "stdin")
          return yield* Effect.fail(notSupported("pipe", command.options.to))
        const left = yield* spawn(command.left)
        if (command.right._tag !== "StandardCommand")
          return yield* Effect.fail(notSupported("pipe", "nested destination"))
        const input =
          command.options.from === "stderr" ? left.stderr : command.options.from === "all" ? left.all : left.stdout
        return yield* spawn(
          ChildProcess.make(command.right.command, command.right.args, { ...command.right.options, stdin: input }),
        )
      }
      const controller = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
      const stdin = command.options.stdin
      const input = stdin && typeof stdin === "object" && !Stream.isStream(stdin) ? stdin.stream : stdin
      let running = true
      const inputText: Effect.Effect<string | undefined, PlatformError> = Stream.isStream(input)
        ? Stream.mkString(Stream.decodeText(input))
        : Effect.succeed(undefined)
      const result = yield* inputText.pipe(
        Effect.flatMap((stdin) =>
          Effect.tryPromise({
            try: (signal) =>
              runBrowserCommand({
                command: command.command,
                args: [...command.args],
                cwd: command.options.cwd,
                env: Object.fromEntries(
                  Object.entries(
                    command.options.extendEnv
                      ? { ...globalThis.process?.env, ...command.options.env }
                      : (command.options.env ?? {}),
                  ).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
                ),
                stdin,
                shell: command.options.shell,
                signal: AbortSignal.any([signal, controller.signal]),
              }),
            catch: (cause) => systemError({ _tag: "Unknown", module: "ChildProcess", method: "spawn", cause }),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            running = false
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      const stdout = Stream.fromEffect(
        Fiber.join(result).pipe(Effect.map((result) => new TextEncoder().encode(result.stdout))),
      )
      const stderr = Stream.fromEffect(
        Fiber.join(result).pipe(Effect.map((result) => new TextEncoder().encode(result.stderr))),
      )
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Fiber.join(result).pipe(Effect.map((result) => ChildProcessSpawner.ExitCode(result.code))),
        isRunning: Effect.sync(() => running),
        kill: () => Effect.sync(() => controller.abort()),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.fail(notSupported("stdin", command.command)),
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.fail(notSupported("input descriptor", command.command)),
        getOutputFd: () => Stream.fail(notSupported("output descriptor", command.command)),
      })
    })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn))
}

export const NodeStream = {
  fromReadable<E>(options: { evaluate: () => Readable; onError: (error: unknown) => E }) {
    return Stream.unwrap(
      Effect.try({ try: options.evaluate, catch: options.onError }).pipe(
        Effect.map((readable) =>
          Stream.fromAsyncIterable(readable, options.onError).pipe(
            Stream.map((chunk: string | Uint8Array) =>
              typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
            ),
          ),
        ),
      ),
    )
  },
}

export const NodeSink = {
  fromWritable<E>(options: {
    evaluate: () => Writable
    onError: (error: unknown) => E
    endOnDone?: boolean
    encoding?: BufferEncoding
  }) {
    return Sink.unwrap(
      Effect.try({ try: options.evaluate, catch: options.onError }).pipe(
        Effect.map((writable) =>
          Sink.forEach((chunk: Uint8Array | string) =>
            Effect.tryPromise({
              try: () =>
                new Promise<void>((resolve, reject) => {
                  writable.write(chunk, options.encoding ?? "utf8", (error) => (error ? reject(error) : resolve()))
                }),
              catch: options.onError,
            }),
          ).pipe(
            Sink.ensuring(
              options.endOnDone
                ? Effect.tryPromise({
                    try: () =>
                      new Promise<void>((resolve, reject) => {
                        writable.once("error", reject)
                        writable.end(() => {
                          writable.off("error", reject)
                          resolve()
                        })
                      }),
                    catch: options.onError,
                  })
                : Effect.void,
            ),
          ),
        ),
      ),
    )
  },
}

// The NodePath subpath import exposes `layer` directly.
export const layer = Path.layer

export const NodeFileSystem = {
  layer: browserFileSystemLayer(),
}

export const NodePath = {
  layer: Path.layer,
}

export const NodeChildProcessSpawner = {
  layer: browserChildProcessSpawnerLayer(),
}

export const NodeRuntime = {
  runMain: (_effect: unknown) => {
    console.warn("NodeRuntime.runMain called in browser - this is a stub")
  },
}

export const NodeHttpServer = {
  layer: Layer.empty,
}

export default {
  NodeFileSystem,
  NodePath,
  NodeChildProcessSpawner,
  NodeRuntime,
  NodeHttpServer,
  NodeSink,
  NodeStream,
}
