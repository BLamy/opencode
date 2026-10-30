declare module "*.wasm" {
  const url: string
  export default url
}

declare module "path-win32" {
  import type path from "node:path"
  const win32: typeof path.win32
  export default win32
}
