import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Catalogue, Ids, type Refusal, Session } from "@exangelos/domain"
import type { OfficialFetchFailed } from "../ports/OfficialPluginSource.ts"

export const Described = Schema.Struct({
  catalogue: Catalogue.Catalogue,
  parameters: Catalogue.Parameters,
  subject: Schema.NonEmptyString,
  label: Schema.String
})
export type Described = typeof Described.Type

export class PluginNotFound extends Schema.TaggedError<PluginNotFound>()("PluginNotFound", {
  plugin: Ids.PluginName
}) {}

export class ParametersInvalid extends Schema.TaggedError<ParametersInvalid>()("ParametersInvalid", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

/** What the plugin half offers the subscription half. */
export class PluginAccess extends Context.Service<PluginAccess, {
  /**
   * Makes the plugin ready, fetching an official plugin on first use and starting it, then asks
   * it to validate and normalise the parameters and name the subject. A fetch records the actor.
   * A plugin with a `PluginRules.problem` fails as unavailable.
   */
  readonly describe: (
    actor: Session.Actor,
    plugin: Ids.PluginName,
    parameters: Catalogue.Parameters
  ) => Effect.Effect<
    Described,
    PluginNotFound | Refusal.PluginUnavailable | OfficialFetchFailed | ParametersInvalid
  >
  /**
   * Runs the subscription's Watch stream from its stored cursor while `Lifecycle.isWatched` holds,
   * handing each item to SubscriptionIntake.ingest. Watching an already watched subscription does
   * nothing.
   */
  readonly watch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /** Stops the subscription's Watch stream. Its cursor stays stored. */
  readonly unwatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
}>()("@exangelos/application/PluginAccess") {}
