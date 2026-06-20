// Browser-compatible fs/promises shim.
// Internal OpenCode state lives in-memory, while the configured workspace root
// can optionally proxy to an external host such as almostnode's VFS.

import { AsyncLocalStorage } from "async_hooks"

const DEFAULT_WORKSPACE_ROOT = "/workspace"

let primaryWorkspaceRoot = DEFAULT_WORKSPACE_ROOT
let workspaceRootAliases = new Set<string>([DEFAULT_WORKSPACE_ROOT])

const _files = new Map<string, string>()
const _dirs = new Set<string>([
  "/",
  "/opencode",
  "/opencode/data",
  "/opencode/cache",
  "/opencode/config",
  "/opencode/state",
  "/opencode/data/log",
  "/opencode/cache/bin",
  DEFAULT_WORKSPACE_ROOT,
])

export interface BrowserWorkspaceDirent {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
}

export interface BrowserWorkspaceStats {
  isFile: () => boolean
  isDirectory: () => boolean
  size: number
  mtime: Date
  mtimeMs: number
}

export interface BrowserWorkspaceBridge {
  exists(path: string): boolean
  mkdir(path: string): void
  readFile(path: string): string | undefined
  writeFile(path: string, content: string): void
  readdir(path: string): BrowserWorkspaceDirent[]
  stat(path: string): BrowserWorkspaceStats | undefined
  remove?(path: string, opts?: { recursive?: boolean }): void
  rename?(oldPath: string, newPath: string): void
  listFiles?(root?: string): string[]
}

export function getWorkspaceRoot(): string {
  return scopedWorkspaceScope.getStore()?.root ?? primaryWorkspaceRoot
}

export function getWorkspaceRoots(): string[] {
  const scoped = scopedWorkspaceScope.getStore()
  if (scoped?.aliases) {
    return Array.from(scoped.aliases)
  }
  return Array.from(workspaceRootAliases)
}

export function setWorkspaceRoot(path: string, aliases: string[] = []): void {
  const normalizedRoot = normalizePath(path)
  primaryWorkspaceRoot = normalizedRoot
  // Aliases accumulate: with several almostnode sandboxes mounted against
  // this module's globals, a background sandbox's root must stay recognized
  // after another sandbox calls setWorkspaceRoot for its own directory.
  workspaceRootAliases.add(DEFAULT_WORKSPACE_ROOT)
  workspaceRootAliases.add(normalizedRoot)
  for (const value of aliases) {
    workspaceRootAliases.add(normalizePath(value))
  }

  for (const root of workspaceRootAliases) {
    _dirs.add(root)
  }
}

let workspaceBridge: BrowserWorkspaceBridge | null = null

/**
 * Per-root workspace bridges: `/sandboxes/{id}` (or `/repos/{id}`) → the
 * bridge for that sandbox's container. Resolution is by longest path prefix
 * of the file being accessed, so it is immune to interleaved async scopes —
 * the AsyncLocalStorage shim below is a plain stack whose `getStore()`
 * returns the most recently entered scope, which is the WRONG bridge when
 * two sandboxes' requests are in flight at once. Paths are namespaced per
 * sandbox, so the path itself is the only trustworthy routing key.
 */
const workspaceBridgesByRoot = new Map<string, BrowserWorkspaceBridge[]>()

export function registerWorkspaceBridgeForRoot(
  root: string,
  bridge: BrowserWorkspaceBridge,
): void {
  const normalizedRoot = normalizePath(root)
  const stack = workspaceBridgesByRoot.get(normalizedRoot)
  if (stack) {
    stack.push(bridge)
  } else {
    workspaceBridgesByRoot.set(normalizedRoot, [bridge])
  }
  workspaceRootAliases.add(normalizedRoot)
  _dirs.add(normalizedRoot)
}

/**
 * Removes exactly this bridge's registration for the root. Each root keeps
 * a stack of registrations (a transient client can coexist with a mounted
 * TUI for the same sandbox), and the newest live registration wins, so an
 * older handle's dispose never tears down a newer one.
 */
export function unregisterWorkspaceBridgeForRoot(
  root: string,
  bridge: BrowserWorkspaceBridge,
): void {
  const normalizedRoot = normalizePath(root)
  const stack = workspaceBridgesByRoot.get(normalizedRoot)
  if (!stack) return
  const index = stack.lastIndexOf(bridge)
  if (index >= 0) {
    stack.splice(index, 1)
  }
  if (stack.length === 0) {
    workspaceBridgesByRoot.delete(normalizedRoot)
  }
}

function resolveWorkspaceBridgeByPath(
  path: string,
): BrowserWorkspaceBridge | null {
  let best: BrowserWorkspaceBridge | null = null
  let bestLength = -1
  for (const [root, stack] of workspaceBridgesByRoot) {
    if (
      stack.length > 0 &&
      (path === root || path.startsWith(`${root}/`)) &&
      root.length > bestLength
    ) {
      best = stack[stack.length - 1]
      bestLength = root.length
    }
  }
  return best
}

/**
 * Request-scoped workspace state: the bridge plus (optionally) the workspace
 * root the request operates on. Scoping the root with the bridge keeps
 * interleaved requests from two sandboxes from crossing VFSes; when a scope
 * carries no root info the module-level globals stay authoritative.
 */
interface WorkspaceScope {
  bridge: BrowserWorkspaceBridge
  root: string | null
  aliases: Set<string> | null
}

const scopedWorkspaceScope = new AsyncLocalStorage<WorkspaceScope>()

export function attachWorkspaceBridge(bridge: BrowserWorkspaceBridge): void {
  workspaceBridge = bridge
  for (const root of workspaceRootAliases) {
    _dirs.add(root)
  }
}

export function detachWorkspaceBridge(): void {
  workspaceBridge = null
}

export function withWorkspaceBridgeScope<T>(
  bridge: BrowserWorkspaceBridge | null | undefined,
  fn: () => T,
  scope?: { root?: string; aliases?: string[] },
): T {
  if (!bridge) {
    return fn()
  }

  let root: string | null = null
  let aliases: Set<string> | null = null
  if (scope?.root) {
    root = normalizePath(scope.root)
    aliases = new Set<string>([
      DEFAULT_WORKSPACE_ROOT,
      root,
      ...(scope.aliases ?? []).map((value) => normalizePath(value)),
    ])
    for (const alias of aliases) {
      _dirs.add(alias)
    }
  }

  for (const dir of workspaceRootAliases) {
    _dirs.add(dir)
  }
  return scopedWorkspaceScope.run({ bridge, root, aliases }, fn)
}

function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean)
  const resolved: string[] = []
  for (const part of parts) {
    if (part === "..") resolved.pop()
    else if (part !== ".") resolved.push(part)
  }
  return "/" + resolved.join("/")
}

function ensureParentDirs(filePath: string) {
  const parts = filePath.split("/").filter(Boolean)
  let current = ""
  for (let index = 0; index < parts.length - 1; index += 1) {
    current += "/" + parts[index]
    _dirs.add(current)
  }
}

function isWorkspacePath(path: string): boolean {
  // Scoped roots win when the active scope carries them; the module globals
  // remain the fallback for legacy callers that only scope the bridge.
  const roots = scopedWorkspaceScope.getStore()?.aliases ?? workspaceRootAliases
  return Array.from(roots).some((root) => (
    path === root || path.startsWith(`${root}/`)
  ))
}

function isBridgedPath(path: string): boolean {
  return path === "/opencode" || path.startsWith("/opencode/")
}

function getWorkspaceBridge(path: string): BrowserWorkspaceBridge | null {
  // Registered per-root bridges win: the path's own namespace prefix is the
  // only routing key that stays correct under interleaved requests from
  // multiple sandboxes. The ambient scope/global remains the fallback for
  // un-namespaced paths (e.g. /opencode/* internals).
  const registered = resolveWorkspaceBridgeByPath(path)
  if (registered) return registered
  const bridge = scopedWorkspaceScope.getStore()?.bridge ?? workspaceBridge
  if (!bridge) return null
  return isWorkspacePath(path) || isBridgedPath(path) ? bridge : null
}

function createDirent(name: string, type: "file" | "directory"): BrowserWorkspaceDirent {
  return {
    name,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
  }
}

// Stable mtimes per internal file. FileTime.assert compares stat mtimes
// between read and write — fabricating `new Date()` on every stat call made
// every overwrite fail with "file has been modified since it was last read".
const _mtimes = new Map<string, number>()

function createStats(type: "file" | "directory", size: number, mtimeMs: number): BrowserWorkspaceStats {
  return {
    isFile: () => type === "file",
    isDirectory: () => type === "directory",
    size,
    mtime: new Date(mtimeMs),
    mtimeMs,
  }
}

function readInternalFile(path: string): string | undefined {
  return _files.get(path)
}

function hasInternalDir(path: string): boolean {
  return _dirs.has(path)
}

function listInternal(path: string): BrowserWorkspaceDirent[] {
  const results: BrowserWorkspaceDirent[] = []
  const seen = new Set<string>()

  for (const [filePath] of _files) {
    if (!filePath.startsWith(`${path}/`)) continue
    const relative = filePath.slice(path.length + 1)
    const name = relative.split("/")[0]
    if (!name || seen.has(name)) continue
    seen.add(name)
    results.push(createDirent(name, relative.includes("/") ? "directory" : "file"))
  }

  for (const dirPath of _dirs) {
    if (!dirPath.startsWith(`${path}/`) || dirPath === path) continue
    const relative = dirPath.slice(path.length + 1)
    const name = relative.split("/")[0]
    if (!name || seen.has(name)) continue
    seen.add(name)
    results.push(createDirent(name, "directory"))
  }

  return results
}

function internalExists(path: string): boolean {
  return _files.has(path) || _dirs.has(path)
}

function internalStat(path: string): BrowserWorkspaceStats | undefined {
  const content = _files.get(path)
  if (content !== undefined) {
    return createStats("file", new TextEncoder().encode(content).length, _mtimes.get(path) ?? 0)
  }

  if (_dirs.has(path)) {
    return createStats("directory", 0, 0)
  }

  return undefined
}

function enoent(action: string, path: string): Error & { code: "ENOENT" } {
  const error = new Error(`ENOENT: no such file or directory, ${action} '${path}'`) as Error & { code: "ENOENT" }
  error.code = "ENOENT"
  return error
}

export async function mkdir(path: string, _opts?: any): Promise<void> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge) {
    bridge.mkdir(normalized)
    return
  }

  _dirs.add(normalized)
  const parts = normalized.split("/").filter(Boolean)
  let current = ""
  for (const part of parts) {
    current += "/" + part
    _dirs.add(current)
  }
}

export async function readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  const content = bridge ? bridge.readFile(normalized) : readInternalFile(normalized)
  if (content === undefined) {
    throw enoent("open", path)
  }

  if (encoding === "utf-8" || encoding === "utf8") return content
  return new TextEncoder().encode(content)
}

export async function writeFile(path: string, data: string | Uint8Array, _opts?: any): Promise<void> {
  const normalized = normalizePath(path)
  const content = typeof data === "string" ? data : new TextDecoder().decode(data)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge) {
    bridge.writeFile(normalized, content)
    return
  }

  ensureParentDirs(normalized)
  _files.set(normalized, content)
  _mtimes.set(normalized, Date.now())
}

export async function appendFile(path: string, data: string | Uint8Array, _opts?: any): Promise<void> {
  const normalized = normalizePath(path)
  const previous = await readFile(normalized, "utf8").catch(() => "")
  const next =
    previous + (typeof data === "string" ? data : new TextDecoder().decode(data))
  await writeFile(normalized, next)
}

export async function readdir(path: string, opts?: any): Promise<any[]> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  const entries = bridge ? bridge.readdir(normalized) : listInternal(normalized)
  return entries.map((entry) =>
    opts?.withFileTypes
      ? entry
      : entry.name
  )
}

export async function stat(path: string): Promise<any> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  const value = bridge ? bridge.stat(normalized) : internalStat(normalized)
  if (value) {
    return value
  }

  throw enoent("stat", path)
}

export const lstat = stat

export async function open(path: string, _flags?: string): Promise<{
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<{ bytesRead: number; buffer: Uint8Array }>
  close(): Promise<void>
}> {
  const content = await readFile(path)
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content

  return {
    async read(buffer: Uint8Array, offset = 0, length = buffer.length, position = 0) {
      const chunk = bytes.slice(position, position + length)
      buffer.set(chunk, offset)
      return {
        bytesRead: chunk.length,
        buffer,
      }
    },
    async close() {},
  }
}

export async function access(path: string): Promise<void> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  const exists = bridge ? bridge.exists(normalized) : internalExists(normalized)
  if (!exists) {
    throw enoent("access", path)
  }
}

export async function unlink(path: string): Promise<void> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge?.remove) {
    bridge.remove(normalized)
    return
  }

  _files.delete(normalized)
  _mtimes.delete(normalized)
}

export async function rm(path: string, opts?: any): Promise<void> {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge?.remove) {
    bridge.remove(normalized, { recursive: Boolean(opts?.recursive) })
    return
  }

  _files.delete(normalized)
  _mtimes.delete(normalized)
  if (opts?.recursive) {
    for (const key of Array.from(_files.keys())) {
      if (key.startsWith(`${normalized}/`)) {
        _files.delete(key)
        _mtimes.delete(key)
      }
    }
    for (const dir of Array.from(_dirs.values())) {
      if (dir === normalized || dir.startsWith(`${normalized}/`)) _dirs.delete(dir)
    }
  }
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  const oldNorm = normalizePath(oldPath)
  const newNorm = normalizePath(newPath)
  const bridge = getWorkspaceBridge(oldNorm)
  if (bridge?.rename) {
    bridge.rename(oldNorm, newNorm)
    return
  }

  const content = _files.get(oldNorm)
  if (content !== undefined) {
    ensureParentDirs(newNorm)
    _files.set(newNorm, content)
    _mtimes.set(newNorm, Date.now())
    _files.delete(oldNorm)
    _mtimes.delete(oldNorm)
  }
}

export async function copyFile(src: string, dest: string): Promise<void> {
  const srcNorm = normalizePath(src)
  const destNorm = normalizePath(dest)
  const content = await readFile(srcNorm, "utf8")
  await writeFile(destNorm, String(content))
}

export async function realpath(path: string): Promise<string> {
  return normalizePath(path)
}

export async function chmod(): Promise<void> {}
export async function chown(): Promise<void> {}
export async function utimes(): Promise<void> {}
export async function link(): Promise<void> {}
export async function symlink(): Promise<void> {}
export async function readlink(path: string): Promise<string> {
  return path
}
export async function mkdtemp(prefix: string): Promise<string> {
  const dir = prefix + Math.random().toString(36).slice(2, 8)
  await mkdir(dir)
  return dir
}

export function _vfs_setFile(path: string, content: string) {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge) {
    bridge.writeFile(normalized, content)
    return
  }

  ensureParentDirs(normalized)
  _files.set(normalized, content)
  _mtimes.set(normalized, Date.now())
}

export function _vfs_getFile(path: string): string | undefined {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  return bridge ? bridge.readFile(normalized) : _files.get(normalized)
}

export function _vfs_listAll(): Map<string, string> {
  const result = new Map(_files)

  const scoped = scopedWorkspaceScope.getStore()
  const bridge = scoped?.bridge ?? workspaceBridge
  if (bridge) {
    const files = bridge.listFiles?.(scoped?.root ?? primaryWorkspaceRoot) ?? []
    for (const path of files) {
      const normalized = normalizePath(path)
      const content = bridge.readFile(normalized)
      if (content !== undefined) {
        result.set(normalized, content)
      }
    }
  }

  return result
}

export function _vfs_addDir(path: string) {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge) {
    bridge.mkdir(normalized)
    return
  }

  _dirs.add(normalized)
}

export function _vfs_remove(path: string, opts?: { recursive?: boolean }) {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  if (bridge?.remove) {
    bridge.remove(normalized, opts)
    return
  }

  _files.delete(normalized)
  _mtimes.delete(normalized)
  if (opts?.recursive) {
    for (const key of Array.from(_files.keys())) {
      if (key.startsWith(`${normalized}/`)) {
        _files.delete(key)
        _mtimes.delete(key)
      }
    }
    for (const dir of Array.from(_dirs.values())) {
      if (dir === normalized || dir.startsWith(`${normalized}/`)) _dirs.delete(dir)
    }
  }
}

export function _vfs_exists(path: string): boolean {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  return bridge ? bridge.exists(normalized) : internalExists(normalized)
}

export function _vfs_isDir(path: string): boolean {
  return Boolean(_vfs_stat(path)?.isDirectory())
}

export function _vfs_stat(path: string): BrowserWorkspaceStats | undefined {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  return bridge ? bridge.stat(normalized) : internalStat(normalized)
}

export function _vfs_readdir(path: string): BrowserWorkspaceDirent[] {
  const normalized = normalizePath(path)
  const bridge = getWorkspaceBridge(normalized)
  return bridge ? bridge.readdir(normalized) : listInternal(normalized)
}

export default {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  lstat,
  open,
  access,
  unlink,
  rm,
  rename,
  copyFile,
  realpath,
  chmod,
  chown,
  utimes,
  link,
  symlink,
  readlink,
  mkdtemp,
  attachWorkspaceBridge,
  detachWorkspaceBridge,
  withWorkspaceBridgeScope,
  _vfs_setFile,
  _vfs_getFile,
  _vfs_listAll,
  _vfs_addDir,
  _vfs_remove,
  _vfs_exists,
  _vfs_isDir,
  _vfs_stat,
  _vfs_readdir,
}
