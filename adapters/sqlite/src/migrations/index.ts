import { Migrator } from "effect/sql"
import initial from "./0001_initial.ts"

/**
 * Every migration, imported statically so the compiled binary carries them. A migration merged
 * into `v1` is never edited; a schema change is a new entry. Rows hold records as JSON through
 * the domain schemas, so a record change that old rows no longer decode under also needs a new
 * entry that rewrites them.
 */
export const migrations = Migrator.fromRecord({
  "0001_initial": initial
})
