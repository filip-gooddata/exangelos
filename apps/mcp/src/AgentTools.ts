import { DateTime, Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { Catalogue, Event, Ids, Plugin, Session, Subscription, Wake } from "@exangelos/domain"
import { AgentClient } from "./AgentClient.ts"
import { type AgentFailure, failureMessage } from "./Messages.ts"

/** A refused or failed call. Its message reaches the agent as the text of an `isError` result. */
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

const SubscriptionResult = Schema.Struct({ subscription: Subscription.Subscription })

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
    SubscriptionResult
  ),
  tool(
    "update",
    "Change a subscription's event types, limits, intent or parameters; a change of subject is refused.",
    { ...id, intent: Schema.optionalKey(Schema.NonEmptyString), ...limits, parameters: Schema.optionalKey(Catalogue.Parameters) },
    SubscriptionResult
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
    SubscriptionResult
  ),
  tool(
    "wait",
    "Wait until a subscription has something for you; text holds the same text a wake would deliver.",
    id,
    Schema.Struct({ text: Schema.String, wake: Wake.WakeContent })
  ),
  tool("pause", "Pause a subscription; nothing is watched until it is resumed.", id, SubscriptionResult),
  tool(
    "resume",
    "Resume a paused subscription with a fresh expiry; acknowledge a backlog over the limit first.",
    id,
    SubscriptionResult
  ),
  tool(
    "retarget",
    "Change which session a subscription wakes: target for a specific session, pullOnly for none, neither for yours.",
    { ...id, ...target },
    SubscriptionResult
  ),
  tool("cancel", "Cancel a subscription for good.", id, SubscriptionResult)
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

/** The tool handlers. Each forwards to the daemon and turns its refusals into messages for the agent. */
export const handlers = toolkit.toLayer(Effect.gen(function*() {
  const client = yield* AgentClient
  return {
    list_plugins: () =>
      client.ListPlugins().pipe(Effect.map((plugins) => ({ plugins })), Effect.mapError(fail)),
    subscribe: ({ target, pullOnly, until, similarOk, ...rest }) =>
      Effect.all([targetChoice({ target, pullOnly }), untilTime(until)])
        .pipe(
          Effect.flatMap(([choice, time]) =>
            client.Subscribe({ ...rest, ...time, target: choice, similarOk: similarOk ?? [] }).pipe(
              Effect.map((subscription) => ({ subscription })),
              Effect.mapError(fail)
            )
          )
        ),
    update: ({ until, ...rest }) =>
      untilTime(until).pipe(
        Effect.flatMap((time) =>
          client.Update({ ...rest, ...time }).pipe(
            Effect.map((subscription) => ({ subscription })),
            Effect.mapError(fail)
          )
        )
      ),
    list: ({ all }) =>
      client.List({ all: all === true }).pipe(
        Effect.map((subscriptions) => ({ subscriptions })),
        Effect.mapError(fail)
      ),
    show: (input) => client.Show(input).pipe(Effect.mapError(fail)),
    events: (input) =>
      client.Events(input).pipe(Effect.map((events) => ({ events })), Effect.mapError(fail)),
    ack: (input) =>
      client.Ack(input).pipe(Effect.map((subscription) => ({ subscription })), Effect.mapError(fail)),
    wait: (input) =>
      client.Wait(input).pipe(
        Effect.map((wake) => ({ text: WakeText.render(wake), wake })),
        Effect.mapError(fail)
      ),
    pause: (input) =>
      client.Pause(input).pipe(Effect.map((subscription) => ({ subscription })), Effect.mapError(fail)),
    resume: (input) =>
      client.Resume(input).pipe(Effect.map((subscription) => ({ subscription })), Effect.mapError(fail)),
    retarget: ({ id, ...choice }) =>
      targetChoice(choice).pipe(
        Effect.flatMap((target) =>
          client.Retarget({ id, target }).pipe(
            Effect.map((subscription) => ({ subscription })),
            Effect.mapError(fail)
          )
        )
      ),
    cancel: (input) =>
      client.Cancel(input).pipe(Effect.map((subscription) => ({ subscription })), Effect.mapError(fail))
  }
}))
