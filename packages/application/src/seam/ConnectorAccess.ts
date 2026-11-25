import { Context, Schema } from "effect"
import type { Effect, Option } from "effect"
import { Catalogue, type Connector, Ids, type Refusal, Session } from "@exangelos/domain"
import type { OfficialFetchFailed } from "../ports/OfficialConnectorSource.ts"

export const Described = Schema.Struct({
  catalogue: Catalogue.Catalogue,
  parameters: Catalogue.Parameters,
  subject: Schema.NonEmptyString,
  label: Schema.String
})
export type Described = typeof Described.Type

export class ConnectorNotFound extends Schema.TaggedError<ConnectorNotFound>()("ConnectorNotFound", {
  connector: Ids.ConnectorName
}) {}

/** What the connector half offers the subscription half. */
export class ConnectorAccess extends Context.Service<ConnectorAccess, {
  /**
   * Makes the connector ready, fetching an official connector on first use and starting it, then asks
   * it to validate and normalise the parameters and name the subject. A fetch records the actor.
   * A connector with a `ConnectorRules.problem` fails as unavailable. Once the connector is ready, `main`
   * joins the parameters under `catalogue.parameters.main` through `Subscribe.withMain`, so a main
   * given both ways with different values fails as ParametersInvalid, as does a Describe refusal.
   */
  readonly describe: (
    actor: Session.Actor,
    connector: Ids.ConnectorName,
    request: { readonly parameters: Catalogue.Parameters; readonly main: Option.Option<string> }
  ) => Effect.Effect<
    Described,
    ConnectorNotFound | Refusal.ConnectorUnavailable | Refusal.ParametersInvalid | OfficialFetchFailed
  >
  /**
   * Runs the subscription's Watch stream from its stored cursor while `Lifecycle.isWatched` holds,
   * handing each item to SubscriptionIntake.ingest. Watching an already watched subscription does
   * nothing.
   */
  readonly watch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /** Stops the subscription's Watch stream. Its cursor stays stored. */
  readonly unwatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /**
   * Stops the subscription's Watch stream, waits until it has stopped, then opens it again from the
   * stored cursor with the stored parameters and event types, as `watch` would. Stopping waits for
   * an item being ingested, so never call it while holding the subscription's lock.
   */
  readonly rewatch: (subscription: Ids.SubscriptionId) => Effect.Effect<void>
  /**
   * Why the subscription's Watch stream keeps failing while its connector runs, from the first
   * failure until an item arrives again or the stream stops. None while it is healthy or unwatched.
   */
  readonly observation: (subscription: Ids.SubscriptionId) => Effect.Effect<Option.Option<Connector.ObservationFailure>>
}>()("@exangelos/application/ConnectorAccess") {}
