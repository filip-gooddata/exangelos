import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { EventRepository, SubscriptionRepository } from "@exangelos/application"
import { layerRepositories } from "@exangelos/application/testing"
import { Effect, Exit, Layer, Option } from "effect"
import * as Database from "../src/Database.ts"
import { migrations } from "../src/migrations/index.ts"
import * as Repositories from "../src/Repositories.ts"
import { event, repositoryContract, subscription } from "./contract.ts"

const repositoriesAt = (filename: string) => Repositories.layer.pipe(Layer.provide(Database.layer({ filename })))

/** The repositories over a fresh database file in a temporary directory, removed afterwards. */
const temporaryRepositories = () =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "exangelos-sqlite-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
    ).pipe(Effect.map((dir) => repositoriesAt(join(dir, "exangelos.db"))))
  )

repositoryContract("SQLite", temporaryRepositories)
repositoryContract("in-memory", () => layerRepositories)

describe("SQLite repositories", () => {
  it.effect("reject a repeated dedupe key and keep the subscription as it was", () =>
    Effect.gen(function*() {
      const events = yield* EventRepository.EventRepository
      const subscriptions = yield* SubscriptionRepository.SubscriptionRepository
      const sub = subscription("sub_a")
      yield* events.append({ ...sub, lastNumber: 1, cursor: "c1" }, [event(sub, 1, "k1")])

      const repeated = yield* Effect.exit(
        events.append({ ...sub, lastNumber: 2, cursor: "c2" }, [event(sub, 2, "k1")])
      )
      expect(Exit.isFailure(repeated)).toBe(true)
      expect(yield* subscriptions.find(sub.id)).toEqual(Option.some({ ...sub, lastNumber: 1, cursor: "c1" }))
      expect((yield* events.list(sub.id)).map((e) => e.number)).toEqual([1])
    }).pipe(Effect.provide(temporaryRepositories())))

  it.effect("keep stored records when the file is reopened and migrated again", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "exangelos-sqlite-"))),
      (dir) =>
        Effect.gen(function*() {
          const filename = join(dir, "exangelos.db")
          const sub = subscription("sub_a")
          yield* EventRepository.EventRepository.use((events) =>
            events.append({ ...sub, lastNumber: 1 }, [event(sub, 1, "k1")])
          ).pipe(Effect.provide(repositoriesAt(filename)))

          const rerun = yield* SqliteMigrator.run({ loader: migrations }).pipe(
            Effect.provide(SqliteClient.layer({ filename }))
          )
          expect(rerun).toEqual([])
          const reopened = yield* EventRepository.EventRepository.use((events) => events.list(sub.id)).pipe(
            Effect.provide(repositoriesAt(filename))
          )
          expect(reopened).toEqual([event(sub, 1, "k1")])
        }),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
    ))
})
