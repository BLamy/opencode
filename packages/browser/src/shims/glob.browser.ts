// Browser-compatible glob shim using VFS
import { _vfs_listAll } from "./fs.browser"
import { hasHiddenSegment, matchGlob } from "./glob-utils.browser"

function normalizePath(input: string): string {
  const parts = input.replace(/\\/g, "/").split("/")
  const resolved: string[] = []

  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") {
      resolved.pop()
      continue
    }
    resolved.push(part)
  }

  return resolved.length ? `/${resolved.join("/")}` : "/"
}

function toRelativePath(root: string, filepath: string): string {
  if (root === "/") {
    return filepath.replace(/^\/+/, "")
  }
  return filepath.slice(root.length + 1)
}

function collectEntries(cwd: string, nodir: boolean): Array<{ absolutePath: string; relativePath: string }> {
  const files = Array.from(_vfs_listAll().keys())
  const results = new Map<string, { absolutePath: string; relativePath: string }>()

  for (const filePath of files) {
    const absolutePath = normalizePath(filePath)
    if (absolutePath !== cwd && !absolutePath.startsWith(`${cwd}/`)) {
      continue
    }

    const relativePath = toRelativePath(cwd, absolutePath)
    if (!relativePath) {
      continue
    }

    results.set(absolutePath, { absolutePath, relativePath })

    if (nodir) {
      continue
    }

    const segments = relativePath.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      const dirRelativePath = segments.slice(0, index).join("/")
      const dirAbsolutePath = cwd === "/" ? `/${dirRelativePath}` : `${cwd}/${dirRelativePath}`
      results.set(dirAbsolutePath, {
        absolutePath: dirAbsolutePath,
        relativePath: dirRelativePath,
      })
    }
  }

  return Array.from(results.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

export class Glob {
  private pattern: string
  private opts: any

  constructor(pattern: string, opts?: any) {
    this.pattern = pattern
    this.opts = opts || {}
  }

  async *[Symbol.asyncIterator]() {
    for (const entry of globSync(this.pattern, this.opts)) {
      yield entry
    }
  }

  static scan(pattern: string, _opts?: any): AsyncIterable<string> {
    const glob = new Glob(pattern)
    return glob
  }
}

export function glob(pattern: string, opts?: any): Promise<string[]> {
  return Promise.resolve(globSync(pattern, opts))
}

export function globSync(pattern: string, opts?: any): string[] {
  const cwd = normalizePath(opts?.cwd ?? "/")
  const nodir = opts?.nodir !== false
  const results: string[] = []

  for (const entry of collectEntries(cwd, nodir)) {
    if (!opts?.dot && hasHiddenSegment(entry.relativePath)) {
      continue
    }

    if (matchGlob(entry.relativePath, pattern, { dot: opts?.dot })) {
      results.push(opts?.absolute ? entry.absolutePath : entry.relativePath)
    }
  }

  return results
}

export default glob
