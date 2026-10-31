// Upstream uses `await using` for file locks, which Safari cannot parse.
export const browserTarget = ["es2022", "safari17"]
