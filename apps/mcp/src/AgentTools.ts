import { DateTime, Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { Catalogue, Event, Ids, Plugin, Session, Subscription, Wake } from "@exangelos/domain"
import * as AgentClient from "./AgentClient.ts"
import { type AgentFailure, failureMessage } from "./Messages.ts"

export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String
}) {}

const id = { id: Ids.SubscriptionId }

const SessionTarget = Schema.Struct({ harness: Session.Harness, sessionId: Schema.NonEmptyString })

const target = {
  target: Schema.optionalKey(SessionTarget),
  pullOnly: Schema.optionalKey(Schema.Boolean)
}

const limits = {
  eventTypes: Schema.optionalKey(Schema.NonEmptyArray(Ids.EventType)),
  maxEvents: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  until: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/)).annotate({
      description: "When the subscription expires: an ISO 8601 time with Z or an offset, such as 2026-12-01T09:00:00Z."
    })
  )
}

const tool = <const Name extends string, Parameters extends Schema.Struct.Fields, Success extends Schema.Top>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success,
    failure: ToolFailure,
    failureMode: "error"
  })

export const toolkit = Toolkit.make(
  Tool.make("list_plugins", {
    description: "List the installed plugins with the event types and parameters each one offers.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ plugins: Schema.Array(Plugin.Plugin) }),
    failure: ToolFailure,
    failureMode: "error"
  }),
  tool(
    "subscribe",
    "Subscribe to a plugin's events; you are woken when they arrive. Say in intent why you want them.",
    {
      plugin: Ids.PluginName,
      parameters: Catalogue.Parameters,
      intent: Schema.NonEmptyString,
      ...limits,
      ...target,
      similarOk: Schema.optionalKey(Schema.Array(Ids.SubscriptionId))
    },
    Subscription.Subscription
  ),
  tool(
    "update",
    "Change a subscription's event types, limits, intent or parameters; a change of subject is refused.",
    { ...id, intent: Schema.optionalKey(Schema.NonEmptyString), ...limits, parameters: Schema.optionalKey(Catalogue.Parameters) },
    Subscription.Subscription
  ),
  tool(
    "list",
    "List this session's subscriptions, or every session's with all: true.",
    { all: Schema.optionalKey(Schema.Boolean) },
    Schema.Struct({ subscriptions: Schema.Array(Subscription.Subscription) })
  ),
  tool(
    "show",
    "Show one subscription with its intent, events, wakes and change history.",
    id,
    DaemonContract.Details
  ),
  tool(
    "events",
    "Read a subscription's stored events with payloads and links, optionally only those after a number.",
    { ...id, after: Schema.optionalKey(Ids.AckedThrough) },
    Schema.Struct({ events: Schema.Array(Event.Event) })
  ),
  tool(
    "ack",
    "Acknowledge a subscription's events up to and including the number in through.",
    { ...id, through: Ids.AckedThrough },
    Subscription.Subscription
  ),
  tool(
    "wait",
    "Wait until a subscription has something for you; text holds the same text a wake would deliver.",
    id,
    Schema.Struct({ text: Schema.String, wake: Wake.WakeContent })
  ),
  tool("pause", "Pause a subscription; nothing is watched until it is resumed.", id, Subscription.Subscription),
  tool(
    "resume",
    "Resume a paused subscription with a fresh expiry; acknowledge a backlog over the limit first.",
    id,
    Subscription.Subscription
  ),
  tool(
    "retarget",
    "Change which session a subscription wakes: target for a specific session, pullOnly for none, neither for yours.",
    { ...id, ...target },
    Subscription.Subscription
  ),
  tool("cancel", "Cancel a subscription for good.", id, Subscription.Subscription)
)

const fail = (failure: AgentFailure) => new ToolFailure({ message: failureMessage(failure) })

const targetChoice = (input: {
  readonly target?: typeof SessionTarget.Type | undefined
  readonly pullOnly?: boolean | undefined
}): Effect.Effect<DaemonContract.TargetChoice, ToolFailure> => {
  if (input.target !== undefined && input.pullOnly === true) {
    return Effect.fail(new ToolFailure({ message: "Pass either target or pullOnly: true, not both." }))
  }
  if (input.target !== undefined) {
    return Effect.succeed(DaemonContract.TargetChoice.cases.Session.make({ session: input.target }))
  }
  return Effect.succeed(
    input.pullOnly === true
      ? DaemonContract.TargetChoice.cases.PullOnly.make({})
      : DaemonContract.TargetChoice.cases.Caller.make({})
  )
}

const untilTime = (until: string | undefined): Effect.Effect<{ readonly until?: DateTime.Utc }, ToolFailure> =>
  until === undefined
    ? Effect.succeed({})
    : Option.match(DateTime.make(until), {
      onNone: () =>
        Effect.fail(
          new ToolFailure({ message: `until is not a valid time: "${until}". Pass an ISO 8601 time such as 2026-12-01T09:00:00Z.` })
        ),
      onSome: (time) => Effect.succeed({ until: DateTime.toUtc(time) })
    })

export const handlers = toolkit.toLayer(Effect.gen(function*() {
  const { connect } = yield* AgentClient.AgentClient
  const call = <A>(use: (client: AgentClient.AgentRpcs) => Effect.Effect<A, AgentFailure>) =>
    Effect.scoped(Effect.flatMap(connect, use)).pipe(Effect.mapError(fail))
  return {
    list_plugins: () => call((client) => client.ListPlugins()).pipe(Effect.map((plugins) => ({ plugins }))),
    subscribe: ({ target, pullOnly, until, similarOk, ...rest }) =>
      Effect.all([targetChoice({ target, pullOnly }), untilTime(until)]).pipe(
        Effect.flatMap(([choice, time]) =>
          call((client) => client.Subscribe({ ...rest, ...time, target: choice, similarOk: similarOk ?? [] }))
        )
      ),
    update: ({ until, ...rest }) =>
      untilTime(until).pipe(Effect.flatMap((time) => call((client) => client.Update({ ...rest, ...time })))),
    list: ({ all }) =>
      call((client) => client.List({ all: all === true })).pipe(Effect.map((subscriptions) => ({ subscriptions }))),
    show: (input) => call((client) => client.Show(input)),
    events: (input) => call((client) => client.Events(input)).pipe(Effect.map((events) => ({ events }))),
    ack: (input) => call((client) => client.Ack(input)),
    wait: (input) =>
      call((client) => client.Wait(input)).pipe(Effect.map((wake) => ({ text: WakeText.render(wake), wake }))),
    pause: (input) => call((client) => client.Pause(input)),
    resume: (input) => call((client) => client.Resume(input)),
    retarget: ({ id, ...choice }) =>
      targetChoice(choice).pipe(Effect.flatMap((target) => call((client) => client.Retarget({ id, target })))),
    cancel: (input) => call((client) => client.Cancel(input))
  }
}))
