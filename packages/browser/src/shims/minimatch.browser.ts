// Minimal minimatch shim for browser
import { matchGlob } from "./glob-utils.browser"

export function minimatch(filepath: string, pattern: string, opts?: any): boolean {
  try {
    return matchGlob(filepath, pattern, { dot: opts?.dot })
  } catch {
    return false
  }
}

export class Minimatch {
  pattern: string
  constructor(pattern: string, _opts?: any) {
    this.pattern = pattern
  }
  match(filepath: string): boolean {
    return minimatch(filepath, this.pattern)
  }
}

export default minimatch
