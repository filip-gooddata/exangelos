import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "../src/Database.ts"
import { migrations } from "../src/migrations/index.ts"

const withFile = <A, E>(use: (filename: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "exangelos-sqlite-"))),
    (dir) => use(join(dir, "exangelos.db")),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
  )

const schema = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{ type: string; name: string }>`
    SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `
})

describe("migrations", () => {
  it.effect("apply to an empty file once, and a second run changes nothing", () =>
    withFile((filename) =>
      Effect.gen(function*() {
        const first = yield* schema.pipe(Effect.provide(Database.layer({ filename })))
        expect(first.filter((row) => row.type === "table").map((row) => row.name)).toEqual([
          "effect_sql_migrations",
          "events",
          "plugin_changes",
          "plugin_values",
          "plugins",
          "subscription_changes",
          "subscriptions",
          "wakes"
        ])

        const second = yield* SqliteMigrator.run({ loader: migrations }).pipe(
          Effect.provide(SqliteClient.layer({ filename }))
        )
        expect(second).toEqual([])
        const after = yield* schema.pipe(Effect.provide(Database.layer({ filename })))
        expect(after).toEqual(first)
      })
    ))

  it.effect("open the file in WAL mode with a busy timeout", () =>
    withFile((filename) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const [journal] = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
        const [timeout] = yield* sql<{ timeout: number }>`PRAGMA busy_timeout`
        expect(journal?.journal_mode).toBe("wal")
        expect(timeout?.timeout).toBe(5000)
      }).pipe(Effect.provide(Database.layer({ filename })))
    ))
})
