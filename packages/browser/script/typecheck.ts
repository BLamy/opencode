import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const dir = path.resolve(import.meta.dir, "..")
const opentui = path.resolve(
  process.env.OPENTUI_DIR ??
    (existsSync(path.join(root, "vendor/opentui")) ? path.join(root, "vendor/opentui") : path.join(root, "../opentui")),
)
const cfg = JSON.parse(await readFile(path.join(dir, "tsconfig.json"), "utf8")) as {
  compilerOptions: { paths: Record<string, string[]> }
}
const paths = Object.fromEntries(
  Object.entries(cfg.compilerOptions.paths).map(([name, values]) => [
    name,
    values.map((value) => path.resolve(dir, value)),
  ]),
)
for (const name of ["core", "solid", "keymap"]) {
  const base = path.join(opentui, "packages", name)
  const pkg = JSON.parse(await readFile(path.join(base, "package.json"), "utf8"))
  for (const [key, entry] of Object.entries(pkg.exports)) {
    const target =
      typeof entry === "string"
        ? entry
        : ((entry as { types?: string; import: string }).types ?? (entry as { import: string }).import)
    paths["@opentui/" + name + (key === "." ? "" : key.slice(1))] = [path.join(base, target)]
  }
}
// The fork's browser entry is not published under upstream's npm package.
// Check the same pinned source that Vite uses, including its public ABI types.
await mkdir(path.join(dir, ".runtime"), { recursive: true })
await writeFile(
  path.join(dir, ".runtime/tsconfig.json"),
  JSON.stringify({ extends: "../tsconfig.json", compilerOptions: { paths } }, null, 2),
)
process.exit(
  await Bun.spawn(
    ["bun", "x", "--no-install", "tsgo", "--noEmit", "--project", path.join(dir, ".runtime/tsconfig.json")],
    { cwd: dir, stdout: "inherit", stderr: "inherit" },
  ).exited,
)
