// Re-export sql-js drizzle driver instead of bun-sqlite
export { drizzle } from "drizzle-orm/sql-js"
export type { SQLJsDatabase as SQLiteBunDatabase } from "drizzle-orm/sql-js"
