type WhichOptions = {
  all?: boolean
  nothrow?: boolean
}

type WhichResult = string | string[] | null

// Browser-compatible 'which' shim
function resolveCommand(cmd: string): string | null {
  switch (cmd) {
    case "rg":
      return "/opencode/cache/bin/rg"
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

const which = Object.assign((cmd: string, options: WhichOptions = {}): Promise<WhichResult> => {
  try {
    return Promise.resolve(resolveResult(cmd, options))
  } catch (error) {
    return Promise.reject(error)
  }
}, { sync })

export default which
