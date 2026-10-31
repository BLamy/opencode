export function installDisposalSymbols(
  symbols: { readonly dispose?: symbol; readonly asyncDispose?: symbol; for(key: string): symbol } = Symbol,
) {
  // esbuild lowers `await using`, but its helper and upstream leases still need
  // matching well-known symbols on Safari. Preserve native symbols when present.
  for (const name of ["dispose", "asyncDispose"] as const) {
    if (symbols[name]) continue
    Object.defineProperty(symbols, name, { value: symbols.for("Symbol." + name) })
  }
}

installDisposalSymbols()
