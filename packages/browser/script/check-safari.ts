import { existsSync } from "node:fs"
import path from "node:path"

const jsc = process.env.JSC_PATH ?? "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
if (!existsSync(jsc)) throw new Error("Safari's JavaScriptCore shell is required. Run this check on macOS.")
const dist = path.resolve(import.meta.dir, "../dist")
const files = Array.from(new Bun.Glob("**/*.js").scanSync({ cwd: dist, absolute: true })).sort()
if (!files.length) throw new Error("Build the browser application before checking Safari compatibility.")
process.exit(
  await Bun.spawn([jsc, path.join(import.meta.dir, "check-safari.js"), "--", ...files], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited,
)
