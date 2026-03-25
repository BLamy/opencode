function splitBraceOptions(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""

  for (const char of input) {
    if (char === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }

    if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
    }

    current += char
  }

  parts.push(current)
  return parts
}

export function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{")
  if (start < 0) {
    return [pattern]
  }

  let depth = 0
  let end = -1
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }

  if (end < 0) {
    return [pattern]
  }

  const prefix = pattern.slice(0, start)
  const suffix = pattern.slice(end + 1)
  const options = splitBraceOptions(pattern.slice(start + 1, end))

  return options.flatMap((option) => expandBraces(`${prefix}${option}${suffix}`))
}

function escapeRegex(char: string): string {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char
}

export function normalizeGlobPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

export function hasHiddenSegment(input: string): boolean {
  return normalizeGlobPath(input)
    .split("/")
    .some((segment) => segment.startsWith(".") && segment.length > 1)
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPath(pattern)
  let output = "^"

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (char === "*" && next === "*") {
      const after = normalized[index + 2]
      if (after === "/") {
        output += "(?:.*/)?"
        index += 2
        continue
      }

      output += ".*"
      index += 1
      continue
    }

    if (char === "*") {
      output += "[^/]*"
      continue
    }

    if (char === "?") {
      output += "[^/]"
      continue
    }

    output += escapeRegex(char)
  }

  output += "$"
  return new RegExp(output)
}

export function matchGlob(filepath: string, pattern: string, opts?: { dot?: boolean }): boolean {
  const normalizedPath = normalizeGlobPath(filepath)
  if (!opts?.dot && hasHiddenSegment(normalizedPath)) {
    return false
  }

  return expandBraces(pattern).some((entry) => globToRegExp(entry).test(normalizedPath))
}
