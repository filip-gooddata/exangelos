import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { Catalogue, Ids } from "@exangelos/domain"
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

export class PluginUnavailable extends Schema.TaggedError<PluginUnavailable>()("PluginUnavailable", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

export class ParametersInvalid extends Schema.TaggedError<ParametersInvalid>()("ParametersInvalid", {
  plugin: Ids.PluginName,
  reason: Schema.String
}) {}

/** What the plugin half offers the subscription half. */
export class PluginAccess extends Context.Service<PluginAccess, {
  /**
   * Makes the plugin ready, fetching an official plugin on first use and starting it, then asks
   * it to validate and normalise the parameters and name the subject.
   */
  readonly describe: (
    plugin: Ids.PluginName,
    parameters: Catalogue.Parameters
  ) => Effect.Effect<Described, PluginNotFound | PluginUnavailable | OfficialFetchFailed | ParametersInvalid>
  /**
   * Runs the subscription's Watch stream from its stored cursor whenever its plugin is available,
   * handing each item to SubscriptionIntake. Watching an already watched subscription does nothing.
   */
  readonly watch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /** Stops the subscription's Watch stream. Its cursor stays stored. */
  readonly unwatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
}>()("@exangelos/application/PluginAccess") {}
