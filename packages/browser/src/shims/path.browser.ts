import path from "path-browserify"
import windows from "path-win32"

export const basename = path.basename
export const dirname = path.dirname
export const extname = path.extname
export const format = path.format
export const isAbsolute = path.isAbsolute
export const join = path.join
export const normalize = path.normalize
export const parse = path.parse
export const relative = path.relative
export const resolve = path.resolve
export const sep = path.sep
export const delimiter = path.delimiter
export const posix = path
export const win32 = windows
export default { ...path, posix, win32 }
