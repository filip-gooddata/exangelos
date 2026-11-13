import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE connectors (
      name TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE connector_values (
      connector TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) STRICT
  `
  yield* sql`
    CREATE TABLE connector_changes (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      connector TEXT NOT NULL,
      record TEXT NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX connector_changes_by_connector ON connector_changes (connector, position)`
  yield* sql`
    CREATE TABLE subscriptions (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      connector TEXT NOT NULL,
      state TEXT NOT NULL,
      target_harness TEXT,
      target_session TEXT,
      created_at INTEGER NOT NULL,
      record TEXT NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX subscriptions_by_age ON subscriptions (created_at, position)`
  yield* sql`
    CREATE TABLE subscription_changes (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription TEXT NOT NULL,
      record TEXT NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX subscription_changes_by_subscription ON subscription_changes (subscription, position)`
  yield* sql`
    CREATE TABLE events (
      subscription TEXT NOT NULL,
      number INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE,
      dedupe_key TEXT NOT NULL,
      record TEXT NOT NULL,
      PRIMARY KEY (subscription, number)
    ) STRICT
  `
  yield* sql`CREATE UNIQUE INDEX events_by_dedupe_key ON events (subscription, dedupe_key)`
  yield* sql`
    CREATE TABLE wakes (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      subscription TEXT NOT NULL,
      state TEXT NOT NULL,
      record TEXT NOT NULL
    ) STRICT
  `
  yield* sql`CREATE INDEX wakes_by_subscription ON wakes (subscription, position)`
  yield* sql`CREATE INDEX wakes_undelivered ON wakes (position) WHERE state IN ('waiting', 'sending')`
})
