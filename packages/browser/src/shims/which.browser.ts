type WhichOptions = {
  all?: boolean
  nothrow?: boolean
}

type WhichResult = string | string[] | null
// Browser-compatible 'which' shim
export function resolveCommand(cmd: string): string | null {
  switch (cmd) {
    case "rg":
      return "/opencode/cache/bin/rg"
    case "node":
      return "/usr/bin/node"
    case "bash":
      return "/bin/sh"
    case "sh":
      return "/bin/sh"
    case "git":
      return "/usr/bin/git"
    default:
      return null
  }
}

function resolveResult(cmd: string, options: WhichOptions = {}): WhichResult {
  const resolved = resolveCommand(cmd)
  if (resolved) {
    return options.all ? [resolved] : resolved
  }

  if (options.nothrow) {
    return options.all ? [] : null
  }

  throw new Error(`which: ${cmd} not available in browser`)
}

export function sync(cmd: string, options: WhichOptions = {}): WhichResult {
  return resolveResult(cmd, options)
}

interface WhichFn {
  (cmd: string, options?: WhichOptions): Promise<WhichResult>
  sync(cmd: string, options?: WhichOptions): WhichResult
}

const which: WhichFn = async (cmd, options) => sync(cmd, options)

which.sync = sync

export default which
