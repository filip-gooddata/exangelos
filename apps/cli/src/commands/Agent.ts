import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { Plugin, Subscription } from "@exangelos/domain"
import * as Text from "../render/Text.ts"
import { Connection } from "./Connection.ts"
import * as Input from "./Input.ts"
import { type Failure, respond } from "./Output.ts"

const subscriptionArgument = Argument.String("subscription").pipe(
  Argument.withDescription("The subscription id, for example sub_7f3k")
)

const parameterArguments = Argument.String("key=value").pipe(
  Argument.withDescription("Further plugin parameters, each as key=value"),
  Argument.variadic()
)

const intentFlag = Flag.String("intent").pipe(
  Flag.withDescription("One line on why you subscribe, written for the person who supervises you")
)
const typesFlag = Flag.String("types").pipe(
  Flag.withDescription("Event types to watch, separated by commas (default: all)"),
  Flag.optional
)
const maxEventsFlag = Flag.Int("max-events").pipe(
  Flag.withDescription("End the subscription after this many events"),
  Flag.optional
)
const untilFlag = Flag.String("until").pipe(
  Flag.withDescription("Expire at this ISO 8601 time"),
  Flag.optional
)
const targetFlag = Flag.String("target").pipe(
  Flag.withDescription("Wake this session instead of the calling one, as <harness>:<session-id>"),
  Flag.optional
)
const pullOnlyFlag = Flag.Boolean("pull-only").pipe(
  Flag.withDescription("Wake no session; collect events with wait and events"),
  Flag.withDefault(false)
)

const SubscriptionSchema = Subscription.Subscription

const plugins = Command.make(
  "plugins",
  {
    name: Argument.String("name").pipe(
      Argument.withDescription("Show this plugin's full catalogue"),
      Argument.optional
    )
  },
  ({ name }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const listed = client.ListPlugins()
      yield* Option.match(name, {
        onNone: () => respond(listed, { schema: Schema.Array(Plugin.Plugin), text: Text.plugins }),
        onSome: (wanted) =>
          respond(
            Effect.flatMap(listed, (all) => {
              const found = all.find((plugin) => plugin.name === wanted)
              return found === undefined
                ? Effect.fail(new DaemonContract.PluginNotFound({ plugin: wanted }))
                : Effect.succeed(found)
            }),
            { schema: Plugin.Plugin, text: Text.plugin }
          )
      })
    })
).pipe(Command.withDescription("List plugins with trust, state and catalogue summary; with a name, show its catalogue"))

const subscribe = Command.make(
  "subscribe",
  {
    plugin: Argument.String("plugin").pipe(Argument.withDescription("The plugin to watch with")),
    main: Argument.String("main").pipe(Argument.withDescription("The plugin's main parameter")),
    parameters: parameterArguments,
    intent: intentFlag,
    types: typesFlag,
    once: Flag.Boolean("once").pipe(Flag.withDescription("End after the first event"), Flag.withDefault(false)),
    maxEvents: maxEventsFlag,
    until: untilFlag,
    target: targetFlag,
    pullOnly: pullOnlyFlag,
    similarOk: Flag.String("similar-ok").pipe(
      Flag.withDescription("Create the subscription next to these similar ones, ids separated by commas"),
      Flag.optional
    )
  },
  (input) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.gen(function*() {
        const payload = {
          plugin: yield* Input.pluginName(input.plugin),
          main: input.main,
          parameters: yield* Input.pairs(input.parameters),
          intent: input.intent.trim(),
          target: yield* Input.target(input),
          similarOk: yield* Input.similarOk(input.similarOk)
        }
        if (payload.intent.length === 0) {
          return yield* new Input.InputInvalid({
            message: "--intent is empty. Say in one line why you subscribe, for example --intent \"fix CI on PR 123\"."
          })
        }
        const eventTypes = yield* Input.eventTypes(input.types)
        const maxEvents = yield* Input.maxEvents(input)
        const until = yield* Input.until(input.until)
        return yield* client.Subscribe({
          ...payload,
          ...(eventTypes === undefined ? {} : { eventTypes }),
          ...(maxEvents === undefined ? {} : { maxEvents }),
          ...(until === undefined ? {} : { until })
        })
      })
      yield* respond(work, {
        schema: SubscriptionSchema,
        text: Text.hinted(Text.subscription),
        json: Text.hintedJson
      })
    })
).pipe(Command.withDescription("Subscribe to events from a plugin on one subject"))

const update = Command.make(
  "update",
  {
    subscription: subscriptionArgument,
    parameters: parameterArguments,
    intent: intentFlag.pipe(Flag.optional),
    types: typesFlag,
    maxEvents: maxEventsFlag,
    until: untilFlag
  },
  (input) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.gen(function*() {
        const id = yield* Input.subscriptionId(input.subscription)
        const parameters = input.parameters.length === 0 ? undefined : yield* Input.pairs(input.parameters)
        const eventTypes = yield* Input.eventTypes(input.types)
        const maxEvents = yield* Input.maxEvents({ maxEvents: input.maxEvents, once: false })
        const until = yield* Input.until(input.until)
        const intent = Option.getOrUndefined(input.intent)
        const change = {
          ...(intent === undefined ? {} : { intent }),
          ...(eventTypes === undefined ? {} : { eventTypes }),
          ...(maxEvents === undefined ? {} : { maxEvents }),
          ...(until === undefined ? {} : { until }),
          ...(parameters === undefined ? {} : { parameters })
        }
        if (Object.keys(change).length === 0) {
          return yield* new Input.InputInvalid({
            message: "Nothing to change. Give key=value parameters or --intent, --types, --max-events or --until."
          })
        }
        return yield* client.Update({ id, ...change })
      })
      yield* respond(work, { schema: SubscriptionSchema, text: Text.subscription, subscription: input.subscription })
    })
).pipe(Command.withDescription("Change event types, limits, intent or parameters of a subscription"))

const list = Command.make(
  "list",
  {
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("List every subscription, not only this session's"),
      Flag.withDefault(false)
    )
  },
  ({ all }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      yield* respond(client.List({ all }), { schema: Schema.Array(SubscriptionSchema), text: Text.subscriptions })
    })
).pipe(Command.withDescription("List this session's subscriptions"))

const show = Command.make("show", { subscription: subscriptionArgument }, ({ subscription }) =>
  Effect.gen(function*() {
    const client = yield* Connection
    const work = Effect.flatMap(Input.subscriptionId(subscription), (id) => client.Show({ id }))
    yield* respond(work, { schema: DaemonContract.Details, text: Text.details, subscription })
  })).pipe(Command.withDescription("Show one subscription with intent, events, wakes and changes"))

const events = Command.make(
  "events",
  {
    subscription: subscriptionArgument,
    after: Flag.Int("after").pipe(Flag.withDescription("Only events after this number"), Flag.optional)
  },
  ({ after, subscription }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(Input.subscriptionId(subscription), (id) =>
        Option.match(after, {
          onNone: () => client.Events({ id }),
          onSome: (number) => client.Events({ id, after: number })
        }))
      yield* respond(work, { schema: DaemonContract.Events.successSchema, text: Text.events, subscription })
    })
).pipe(Command.withDescription("Print stored events with payloads and links"))

const ack = Command.make(
  "ack",
  {
    subscription: subscriptionArgument,
    through: Flag.Int("through").pipe(Flag.withDescription("Acknowledge every event up to this number"))
  },
  ({ subscription, through }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(Input.subscriptionId(subscription), (id) => client.Ack({ id, through }))
      yield* respond(work, {
        schema: SubscriptionSchema,
        text: (acked) => `Acknowledged ${acked.id} through #${acked.ackedThrough}.`,
        subscription
      })
    })
).pipe(Command.withDescription("Acknowledge events through number N"))

const wait = Command.make("wait", { subscription: subscriptionArgument }, ({ subscription }) =>
  Effect.gen(function*() {
    const client = yield* Connection
    const work = Effect.flatMap(Input.subscriptionId(subscription), (id) => client.Wait({ id }))
    yield* respond(work, {
      schema: DaemonContract.Wait.successSchema,
      text: WakeText.render,
      json: (content, wake) => ({ text: WakeText.render(content), wake }),
      subscription
    })
  })).pipe(Command.withDescription("Block until there is something to say, then print the wake text"))

const stateChange = <E extends Failure>(
  name: "pause" | "resume" | "cancel",
  description: string,
  call: (
    client: Connection["Service"],
    id: Subscription.Subscription["id"]
  ) => Effect.Effect<Subscription.Subscription, E>,
  options: { readonly hint?: boolean } = {}
) =>
  Command.make(name, { subscription: subscriptionArgument }, ({ subscription }) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.flatMap(Input.subscriptionId(subscription), (id) => call(client, id))
      const text = (changed: Subscription.Subscription) => `${changed.id} is ${Text.stateText(changed.state)}.`
      yield* respond(work, {
        schema: SubscriptionSchema,
        text: options.hint ? Text.hinted(text) : text,
        ...(options.hint ? { json: Text.hintedJson } : {}),
        subscription
      })
    })).pipe(Command.withDescription(description))

const retarget = Command.make(
  "retarget",
  { subscription: subscriptionArgument, target: targetFlag, pullOnly: pullOnlyFlag },
  (input) =>
    Effect.gen(function*() {
      const client = yield* Connection
      const work = Effect.gen(function*() {
        const id = yield* Input.subscriptionId(input.subscription)
        if (!input.pullOnly && Option.isNone(input.target)) {
          return yield* new Input.InputInvalid({
            message: "Give the new wake target with --target <harness>:<session-id>, or --pull-only to wake no session."
          })
        }
        return yield* client.Retarget({ id, target: yield* Input.target(input) })
      })
      yield* respond(work, {
        schema: SubscriptionSchema,
        text: (changed) =>
          changed.wakeTarget === undefined
            ? `${changed.id} is pull-only now.`
            : `${changed.id} now wakes ${changed.wakeTarget.harness}:${changed.wakeTarget.sessionId}.`,
        subscription: input.subscription
      })
    })
).pipe(Command.withDescription("Set a new wake target, or make the subscription pull-only"))

/** The agent commands, also offered to agents over MCP. */
export const commands = [
  plugins,
  subscribe,
  update,
  list,
  show,
  events,
  ack,
  wait,
  stateChange("pause", "Pause a subscription", (client, id) => client.Pause({ id })),
  stateChange("resume", "Resume a subscription with a fresh expiry", (client, id) => client.Resume({ id }), {
    hint: true
  }),
  retarget,
  stateChange("cancel", "Cancel a subscription", (client, id) => client.Cancel({ id }))
] as const
