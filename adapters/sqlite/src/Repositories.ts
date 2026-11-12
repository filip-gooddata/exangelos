import { EventRepository, PluginRepository, SubscriptionRepository, WakeRepository } from "@exangelos/application"
import { Catalogue, Event, Plugin, Subscription, Wake } from "@exangelos/domain"
import type { Ids } from "@exangelos/domain"
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

/** A record stored as JSON text through its schema's JSON codec. */
const column = <S extends Schema.Codec<any, any, never, never>>(schema: S) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
  return {
    encode: (value: S["Type"]): Effect.Effect<string> => Effect.orDie(Schema.encodeEffect(codec)(value)),
    decode: (text: string): Effect.Effect<S["Type"]> => Effect.orDie(Schema.decodeEffect(codec)(text))
  }
}

const plugins = column(Plugin.Plugin)
const pluginChanges = column(PluginRepository.PluginChange)
const values = column(Catalogue.ConfigurationValues)
const subscriptions = column(Subscription.Subscription)
const subscriptionChanges = column(Subscription.Change)
const events = column(Event.Event)
const wakes = column(Wake.Wake)

interface Row {
  readonly record: string
}

const undelivered = ["waiting", "sending"] as const

/** The four repositories over the SQL client, so writes that span them share one transaction. */
export const layer: Layer.Layer<
  | PluginRepository.PluginRepository
  | SubscriptionRepository.SubscriptionRepository
  | EventRepository.EventRepository
  | WakeRepository.WakeRepository,
  never,
  SqlClient.SqlClient
> = Layer.unwrap(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect)
  const write = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(sql.withTransaction(effect))
  const decodeAll = <A>(rows: ReadonlyArray<Row>, decode: (text: string) => Effect.Effect<A>) =>
    Effect.forEach(rows, (row) => decode(row.record))
  const decodeFirst = <A>(rows: ReadonlyArray<Row>, decode: (text: string) => Effect.Effect<A>) =>
    Option.match(Arr.head(rows), {
      onNone: () => Effect.succeedNone,
      onSome: (row) => Effect.asSome(decode(row.record))
    })

  const appendPluginChange = (change: PluginRepository.PluginChange) =>
    Effect.flatMap(
      pluginChanges.encode(change),
      (record) => sql`INSERT INTO plugin_changes (plugin, record) VALUES (${change.plugin}, ${record})`
    )

  const pluginRepository = PluginRepository.PluginRepository.of({
    find: (name) =>
      run(sql<Row>`SELECT record FROM plugins WHERE name = ${name}`).pipe(
        Effect.flatMap((rows) => decodeFirst(rows, plugins.decode))
      ),
    list: run(sql<Row>`SELECT record FROM plugins ORDER BY name`).pipe(
      Effect.flatMap((rows) => decodeAll(rows, plugins.decode))
    ),
    store: (plugin, change) =>
      write(Effect.gen(function*() {
        const record = yield* plugins.encode(plugin)
        yield* sql`
          INSERT INTO plugins (name, record) VALUES (${plugin.name}, ${record})
          ON CONFLICT (name) DO UPDATE SET record = excluded.record
        `
        if (change !== undefined) yield* appendPluginChange(change)
      })),
    remove: (name, change) =>
      write(Effect.gen(function*() {
        yield* sql`DELETE FROM plugins WHERE name = ${name}`
        yield* sql`DELETE FROM plugin_values WHERE plugin = ${name}`
        yield* appendPluginChange(change)
      })),
    changes: (name) =>
      run(sql<Row>`SELECT record FROM plugin_changes WHERE plugin = ${name} ORDER BY position`).pipe(
        Effect.flatMap((rows) => decodeAll(rows, pluginChanges.decode))
      ),
    values: (name) =>
      run(sql<Row>`SELECT record FROM plugin_values WHERE plugin = ${name}`).pipe(
        Effect.flatMap((rows) => decodeFirst(rows, values.decode)),
        Effect.map(Option.getOrElse((): Catalogue.ConfigurationValues => ({})))
      ),
    storeValues: (name, configuration) =>
      write(Effect.gen(function*() {
        const record = yield* values.encode(configuration)
        yield* sql`
          INSERT INTO plugin_values (plugin, record) VALUES (${name}, ${record})
          ON CONFLICT (plugin) DO UPDATE SET record = excluded.record
        `
      }))
  })

  const storeSubscription = (subscription: Subscription.Subscription) =>
    Effect.gen(function*() {
      const record = yield* subscriptions.encode(subscription)
      const row = {
        id: subscription.id,
        plugin: subscription.plugin,
        state: subscription.state._tag,
        target_harness: subscription.wakeTarget?.harness ?? null,
        target_session: subscription.wakeTarget?.sessionId ?? null,
        created_at: DateTime.toEpochMillis(subscription.createdAt),
        record
      }
      yield* sql`
        INSERT INTO subscriptions ${sql.insert(row)}
        ON CONFLICT (id) DO UPDATE SET
          plugin = excluded.plugin,
          state = excluded.state,
          target_harness = excluded.target_harness,
          target_session = excluded.target_session,
          created_at = excluded.created_at,
          record = excluded.record
      `
    })

  const subscriptionRepository = SubscriptionRepository.SubscriptionRepository.of({
    find: (id) =>
      run(sql<Row>`SELECT record FROM subscriptions WHERE id = ${id}`).pipe(
        Effect.flatMap((rows) => decodeFirst(rows, subscriptions.decode))
      ),
    list: (filter) => {
      if (filter.states !== undefined && filter.states.length === 0) return Effect.succeed([])
      const where = sql.and([
        ...(filter.states === undefined ? [] : [sql.in("state", filter.states)]),
        ...(filter.plugin === undefined ? [] : [sql`plugin = ${filter.plugin}`]),
        ...(filter.target === undefined
          ? []
          : [sql`target_harness = ${filter.target.harness} AND target_session = ${filter.target.sessionId}`])
      ])
      return run(sql<Row>`SELECT record FROM subscriptions WHERE ${where} ORDER BY created_at, position`).pipe(
        Effect.flatMap((rows) => decodeAll(rows, subscriptions.decode))
      )
    },
    store: (subscription, change) =>
      write(Effect.gen(function*() {
        yield* storeSubscription(subscription)
        if (change !== undefined) {
          const record = yield* subscriptionChanges.encode(change)
          yield* sql`
            INSERT INTO subscription_changes (subscription, record) VALUES (${change.subscription}, ${record})
          `
        }
      })),
    changes: (id) =>
      run(
        sql<Row>`SELECT record FROM subscription_changes WHERE subscription = ${id} ORDER BY position`
      ).pipe(Effect.flatMap((rows) => decodeAll(rows, subscriptionChanges.decode))),
    remove: (ids) =>
      ids.length === 0 ? Effect.void : write(Effect.gen(function*() {
        yield* sql`DELETE FROM events WHERE ${sql.in("subscription", ids)}`
        yield* sql`DELETE FROM wakes WHERE ${sql.in("subscription", ids)}`
        yield* sql`DELETE FROM subscription_changes WHERE ${sql.in("subscription", ids)}`
        yield* sql`DELETE FROM subscriptions WHERE ${sql.in("id", ids)}`
      }))
  })

  const eventRepository = EventRepository.EventRepository.of({
    append: (subscription, appended) =>
      write(Effect.gen(function*() {
        yield* storeSubscription(subscription)
        for (const event of appended) {
          const record = yield* events.encode(event)
          yield* sql`
            INSERT INTO events (subscription, number, id, dedupe_key, record)
            VALUES (${event.subscription}, ${event.number}, ${event.id}, ${event.dedupeKey}, ${record})
          `
        }
      })),
    list: (subscription, after = 0) =>
      run(
        sql<Row>`SELECT record FROM events WHERE subscription = ${subscription} AND number > ${after} ORDER BY number`
      ).pipe(Effect.flatMap((rows) => decodeAll(rows, events.decode))),
    findByDedupeKey: (subscription, dedupeKey) =>
      run(
        sql<Row>`SELECT record FROM events WHERE subscription = ${subscription} AND dedupe_key = ${dedupeKey}`
      ).pipe(Effect.flatMap((rows) => decodeFirst(rows, events.decode)))
  })

  const storeWake = (wake: Wake.Wake) =>
    Effect.flatMap(
      wakes.encode(wake),
      (record) => sql`UPDATE wakes SET state = ${wake.state}, record = ${record} WHERE id = ${wake.id}`
    )

  const undeliveredOf = (subscription: Ids.SubscriptionId) =>
    sql<Row>`
      SELECT record FROM wakes
      WHERE subscription = ${subscription} AND ${sql.in("state", undelivered)}
      ORDER BY position
    `

  const wakeRepository = WakeRepository.WakeRepository.of({
    add: (wake) =>
      write(Effect.gen(function*() {
        const replaced = yield* undeliveredOf(wake.subscription).pipe(
          Effect.flatMap((rows) => decodeAll(rows, wakes.decode))
        )
        yield* Effect.forEach(replaced, (other) => storeWake({ ...other, state: "replaced" }), { discard: true })
        const record = yield* wakes.encode(wake)
        yield* sql`
          INSERT INTO wakes (id, subscription, state, record)
          VALUES (${wake.id}, ${wake.subscription}, ${wake.state}, ${record})
        `
      })),
    update: (wake) => write(storeWake(wake)),
    list: (subscription) =>
      run(sql<Row>`SELECT record FROM wakes WHERE subscription = ${subscription} ORDER BY position`).pipe(
        Effect.flatMap((rows) => decodeAll(rows, wakes.decode))
      ),
    findUndelivered: (subscription) =>
      run(undeliveredOf(subscription)).pipe(Effect.flatMap((rows) => decodeFirst(rows, wakes.decode))),
    listUndelivered: run(
      sql<Row>`SELECT record FROM wakes WHERE ${sql.in("state", undelivered)} ORDER BY position`
    ).pipe(Effect.flatMap((rows) => decodeAll(rows, wakes.decode)))
  })

  return Layer.mergeAll(
    Layer.succeed(PluginRepository.PluginRepository, pluginRepository),
    Layer.succeed(SubscriptionRepository.SubscriptionRepository, subscriptionRepository),
    Layer.succeed(EventRepository.EventRepository, eventRepository),
    Layer.succeed(WakeRepository.WakeRepository, wakeRepository)
  )
}))
