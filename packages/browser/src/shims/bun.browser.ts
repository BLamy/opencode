import wrapAnsiNpm from "wrap-ansi"
import * as yaml from "yaml"
import { compare, satisfies as semverSatisfies } from "./semver.browser"
import { resolveCommand } from "./which.browser"

function normalizePathname(pathname: string): string {
  if (pathname.startsWith("/") && /^[A-Za-z]:/.test(pathname.slice(1))) {
    return pathname.slice(1)
  }

  return pathname
}

export function fileURLToPath(input: string | URL): string {
  const url = input instanceof URL ? input : new URL(input)
  if (url.protocol !== "file:") {
    throw new TypeError(`Expected file URL, received ${url.protocol}`)
  }
  return decodeURIComponent(normalizePathname(url.pathname))
}

export function pathToFileURL(path: string): URL {
  const normalized = path.startsWith("/") ? path : `/${path}`
  const segments = normalized.split("/").map((segment, index) => {
    if (index === 0) return ""
    return encodeURIComponent(segment).replace(/%3A/gi, ":")
  })
  return new URL(`file://${segments.join("/")}`)
}

function stripANSI(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function stringWidth(input: string): number {
  return Array.from(stripANSI(input)).length
}

async function stdinText(): Promise<string> {
  return ""
}

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

type HashInput = string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView
type HashSeed = number | bigint
type BunHash64 = (input: HashInput, seed?: HashSeed) => bigint
type BunHash32 = (input: HashInput, seed?: HashSeed) => number
type BunHash = BunHash64 & {
  wyhash: BunHash64
  rapidhash: BunHash64
  cityHash64: BunHash64
  xxHash64: BunHash64
  xxHash3: BunHash64
  murmur64v2: BunHash64
  crc32: BunHash32
  adler32: BunHash32
  cityHash32: BunHash32
  xxHash32: BunHash32
  murmur32v2: BunHash32
  murmur32v3: BunHash32
}

const textEncoder = new TextEncoder()
const FNV32_OFFSET_BASIS = 0x811c9dc5
const FNV32_PRIME = 0x01000193
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const UTF8_BOM = "\ufeff"

function normalizeHashInput(input: HashInput): Uint8Array {
  if (typeof input === "string") {
    return textEncoder.encode(input)
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }

  if (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) {
    return new Uint8Array(input)
  }

  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }

  throw new TypeError("Bun.hash input must be a string, TypedArray, DataView, ArrayBuffer, or SharedArrayBuffer")
}

function normalizeSeed(seed: HashSeed | undefined): bigint {
  if (typeof seed === "bigint") {
    return seed
  }

  if (typeof seed === "number" && Number.isFinite(seed)) {
    return BigInt(Math.trunc(seed))
  }

  return 0n
}

function hash64(input: HashInput, seed?: HashSeed, salt = 0n): bigint {
  const bytes = normalizeHashInput(input)
  let value = BigInt.asUintN(64, FNV64_OFFSET_BASIS ^ normalizeSeed(seed) ^ salt)

  for (const byte of bytes) {
    value ^= BigInt(byte)
    value = BigInt.asUintN(64, value * FNV64_PRIME)
  }

  return value
}

function hash32(input: HashInput, seed?: HashSeed, salt = 0): number {
  const bytes = normalizeHashInput(input)
  let value = (FNV32_OFFSET_BASIS ^ Number(BigInt.asUintN(32, normalizeSeed(seed))) ^ salt) >>> 0

  for (const byte of bytes) {
    value ^= byte
    value = Math.imul(value, FNV32_PRIME) >>> 0
  }

  return value >>> 0
}

const hash = ((input: HashInput, seed?: HashSeed) => hash64(input, seed)) as BunHash

hash.wyhash = (input, seed) => hash64(input, seed)
hash.rapidhash = (input, seed) => hash64(input, seed, 0x71374491428a2f98n)
hash.cityHash64 = (input, seed) => hash64(input, seed, 0xa4093822299f31d0n)
hash.xxHash64 = (input, seed) => hash64(input, seed, 0x243f6a8885a308d3n)
hash.xxHash3 = (input, seed) => hash64(input, seed, 0x13198a2e03707344n)
hash.murmur64v2 = (input, seed) => hash64(input, seed, 0x082efa98ec4e6c89n)

hash.crc32 = (input, seed) => hash32(input, seed)
hash.adler32 = (input, seed) => hash32(input, seed, 0x9e3779b9)
hash.cityHash32 = (input, seed) => hash32(input, seed, 0x85ebca6b)
hash.xxHash32 = (input, seed) => hash32(input, seed, 0xc2b2ae35)
hash.murmur32v2 = (input, seed) => hash32(input, seed, 0x27d4eb2d)
hash.murmur32v3 = (input, seed) => hash32(input, seed, 0x165667b1)

function unsupportedListen(): never {
  throw new Error("Bun.listen is unavailable in browser mode")
}

function unsupportedSpawn(): never {
  throw new Error("Bun.spawn is unavailable in browser mode")
}

function unsupportedGenerateHeapSnapshot(): never {
  throw new Error("Bun.generateHeapSnapshot is unavailable in browser mode")
}

function gc(): void {}

function wrapAnsi(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  return wrapAnsiNpm(input, columns, options)
}

type JSONLParseResult = {
  values: unknown[]
  error: null | Error
  read: number
  done: boolean
}

function normalizeJSONLInput(data: string | Buffer, offset: number): { content: string; offset: number; length: number } {
  if (typeof data === "string") {
    const normalizedOffset =
      offset === 0 && data.startsWith(UTF8_BOM)
        ? UTF8_BOM.length
        : offset
    return {
      content: data,
      offset: normalizedOffset,
      length: data.length,
    }
  }

  let normalizedOffset = offset
  if (
    normalizedOffset === 0 &&
    data.length >= 3 &&
    data[0] === 0xef &&
    data[1] === 0xbb &&
    data[2] === 0xbf
  ) {
    normalizedOffset = 3
  }

  return {
    content: data.toString("utf8"),
    offset: normalizedOffset,
    length: data.length,
  }
}

function parseJSONLChunk(
  data: string | Buffer,
  offset = 0,
): JSONLParseResult {
  const normalized = normalizeJSONLInput(data, offset)
  const values: unknown[] = []
  let cursor = normalized.offset

  while (cursor < normalized.length) {
    const newlineIndex = normalized.content.indexOf("\n", cursor)
    const lineEnd = newlineIndex === -1 ? normalized.length : newlineIndex
    const rawLine = normalized.content.slice(cursor, lineEnd)
    const line = rawLine.trim()

    if (line) {
      try {
        values.push(JSON.parse(line))
      } catch (error) {
        return {
          values,
          error: error instanceof Error ? error : new Error(String(error)),
          read: cursor,
          done: false,
        }
      }
    }

    if (newlineIndex === -1) {
      return {
        values,
        error: null,
        read: normalized.length,
        done: true,
      }
    }

    cursor = newlineIndex + 1
  }

  return {
    values,
    error: null,
    read: normalized.length,
    done: true,
  }
}

const JSONL = {
  parseChunk: parseJSONLChunk,
}

const semver = {
  order(a: string, b: string): -1 | 0 | 1 {
    const result = compare(a, b, { loose: true })
    if (result > 0) return 1
    if (result < 0) return -1
    return 0
  },
  satisfies(version: string, range: string): boolean {
    return semverSatisfies(version, range, { loose: true })
  },
}

const YAML = {
  parse(input: string): unknown {
    return yaml.parse(input)
  },
  stringify(value: unknown): string {
    return yaml.stringify(value)
  },
}

export function which(cmd: string): string | null {
  return resolveCommand(cmd)
}

function unsupportedServe(): never {
  throw new Error("Bun.serve is unavailable in browser mode")
}

function unsupportedTemplateTag(): never {
  throw new Error("Bun.$ is unavailable in browser mode")
}

const BunShim = {
  fileURLToPath,
  pathToFileURL,
  listen: unsupportedListen,
  serve: unsupportedServe,
  spawn: unsupportedSpawn,
  stdin: {
    text: stdinText,
  },
  which,
  hash,
  semver,
  YAML,
  JSONL,
  gc,
  wrapAnsi,
  embeddedFiles: [] as string[],
  generateHeapSnapshot: unsupportedGenerateHeapSnapshot,
  stringWidth,
  stripANSI,
  $: unsupportedTemplateTag,
  version: "browser",
}

function ensureGlobalBunBinding(): void {
  const globalEval = globalThis.eval as ((source: string) => unknown) | undefined
  if (typeof globalEval !== "function") {
    return
  }

  try {
    globalEval("var Bun = globalThis.Bun;")
  } catch {
    // Ignore environments that block eval; those call sites must fall back to imports.
  }
}

if (typeof globalThis.Bun === "undefined") {
  Object.defineProperty(globalThis, "Bun", {
    value: BunShim,
    writable: true,
    configurable: true,
  })
} else if (
  (typeof globalThis.Bun === "object" && globalThis.Bun !== null) ||
  typeof globalThis.Bun === "function"
) {
  Object.assign(globalThis.Bun, BunShim)
}

ensureGlobalBunBinding()

export const serve = unsupportedServe
export const stdin = BunShim.stdin
export const listen = unsupportedListen
export const spawn = unsupportedSpawn
export const generateHeapSnapshot = unsupportedGenerateHeapSnapshot
export const embeddedFiles = BunShim.embeddedFiles
export { JSONL, YAML, gc, hash, semver, stringWidth, stripANSI, wrapAnsi }
export const $ = unsupportedTemplateTag
export const version = BunShim.version

export default BunShim
