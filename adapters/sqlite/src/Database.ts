import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { migrations } from "./migrations/index.ts"

export interface Options {
  /** Absolute path of the database file in the data directory. */
  readonly filename: string
}

/**
 * Opens the database file, creating it when absent, and applies every pending migration before
 * the layer is built.
 */
export const layer = (options: Options) =>
  SqliteMigrator.layer({ loader: migrations }).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: options.filename }))
  )
