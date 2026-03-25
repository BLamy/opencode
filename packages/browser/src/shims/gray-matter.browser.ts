import { parse } from "yaml"

type GrayMatterFile<T = Record<string, unknown>> = {
  content: string
  data: T
  excerpt: string
  language: string
  matter: string
  orig: string
  stringify: () => string
}

function parseFrontmatter(input: string): { content: string; data: Record<string, unknown>; matter: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/.exec(input)
  if (!match) {
    return {
      content: input,
      data: {},
      matter: "",
    }
  }

  const rawMatter = match[1]
  const parsed = parse(rawMatter)
  if (parsed !== null && parsed !== undefined && typeof parsed !== "object") {
    throw new TypeError("Frontmatter must evaluate to an object")
  }

  return {
    content: input.slice(match[0].length),
    data: (parsed ?? {}) as Record<string, unknown>,
    matter: rawMatter,
  }
}

export default function matter(input: string): GrayMatterFile {
  const parsed = parseFrontmatter(input)
  return {
    content: parsed.content,
    data: parsed.data,
    excerpt: "",
    language: "yaml",
    matter: parsed.matter,
    orig: input,
    stringify() {
      if (!parsed.matter) {
        return parsed.content
      }
      return `---\n${parsed.matter}\n---\n${parsed.content}`
    },
  }
}
