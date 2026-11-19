import { Cause, Clock, DateTime, Effect, Exit, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { Catalogue, Event, Ids, Connector, Session, Subscription, Wake } from "@exangelos/domain"
import { Redact } from "@exangelos/logging"
import * as AgentClient from "./AgentClient.ts"
import { type AgentFailure, failureMessage, wakeHint } from "./Messages.ts"

export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String
}) {}

const id = { id: Ids.SubscriptionId }

const SessionTarget = Session.Target.annotate({
  description: "A session to wake: harness t3, codex or claude-code, or a harness the user defined in Exangelos settings, and its session id"
})

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

const Hinted = Schema.Struct({ ...Subscription.Subscription.fields, hint: Schema.optionalKey(Schema.String) })

const withHint = (subscription: Subscription.Subscription) =>
  Option.match(wakeHint(subscription), {
    onNone: () => subscription,
    onSome: (hint) => ({ ...subscription, hint })
  })

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
  Tool.make("list_connectors", {
    description: "List the installed connectors with the event types and parameters each one offers.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({ connectors: Schema.Array(Connector.Connector) }),
    failure: ToolFailure,
    failureMode: "error"
  }),
  tool(
    "subscribe",
    "Subscribe to a connector's events; you are woken when they arrive. Say in intent why you want them.",
    {
      connector: Ids.ConnectorName,
      parameters: Catalogue.Parameters,
      intent: Schema.NonEmptyString,
      ...limits,
      ...target,
      similarOk: Schema.optionalKey(Schema.Array(Ids.SubscriptionId))
    },
    Hinted
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
    Hinted
  ),
  tool(
    "retarget",
    "Change which session a subscription wakes: target for a specific session, pullOnly for none, neither for yours.",
    { ...id, ...target },
    Subscription.Subscription
  ),
  tool("cancel", "Cancel a subscription for good.", id, Subscription.Subscription),
  tool(
    "set_event_alerts",
    "Turn this subscription's own event alerts on or off; only for a subscription this session created. When the user has event alerts on globally, every subscription alerts whatever this says.",
    { ...id, eventAlerts: Schema.Boolean },
    Subscription.Subscription
  )
)

const fail = (failure: AgentFailure, subscription?: string) =>
  new ToolFailure({ message: failureMessage(failure, subscription) })

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

const report = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return Effect.logInfo("tool called").pipe(Effect.annotateLogs({ outcome: "ok" }))
  const log = Cause.hasInterruptsOnly(exit.cause)
    ? Effect.logDebug
    : Cause.hasDies(exit.cause)
    ? Effect.logError
    : Effect.logWarning
  return log("tool failed", Cause.map(exit.cause, (error) => Redact.describeFailure(error))).pipe(Effect.annotateLogs({ outcome: "error" }))
}

const logged = (tool: string) => <A, E, R>(handle: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    handle.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
          report(exit).pipe(Effect.annotateLogs({ durationMs: endedAt - startedAt }))))
    )).pipe(Effect.annotateLogs({ request: crypto.randomUUID(), method: tool }))

type Handlers = Toolkit.HandlersFrom<Toolkit.Tools<typeof toolkit>>

const instrumented = <H extends Handlers>(handlers: H): H =>
  Object.fromEntries(
    Object.entries(handlers).map(([tool, handle]) => [
      tool,
      (input: never, context: never) =>
        logged(tool)((handle as (input: never, context: never) => Effect.Effect<unknown, unknown>)(input, context))
    ])
  ) as unknown as H

export const handlers = toolkit.toLayer(Effect.gen(function*() {
  const { connect } = yield* AgentClient.AgentClient
  const call = <A>(use: (client: AgentClient.AgentRpcs) => Effect.Effect<A, AgentFailure>, subscription?: string) =>
    Effect.scoped(Effect.flatMap(connect, use)).pipe(Effect.mapError((failure) => fail(failure, subscription)))
  return instrumented({
    list_connectors: () => call((client) => client.ListConnectors()).pipe(Effect.map((connectors) => ({ connectors }))),
    subscribe: ({ target, pullOnly, until, similarOk, ...rest }) =>
      Effect.all([targetChoice({ target, pullOnly }), untilTime(until)]).pipe(
        Effect.flatMap(([choice, time]) =>
          call((client) => client.Subscribe({ ...rest, ...time, target: choice, similarOk: similarOk ?? [] }))
        ),
        Effect.map(withHint)
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
    resume: (input) => call((client) => client.Resume(input), input.id).pipe(Effect.map(withHint)),
    retarget: ({ id, ...choice }) =>
      targetChoice(choice).pipe(Effect.flatMap((target) => call((client) => client.Retarget({ id, target })))),
    cancel: (input) => call((client) => client.Cancel(input)),
    set_event_alerts: (input) => call((client) => client.SetEventAlerts(input), input.id)
  })
}))
