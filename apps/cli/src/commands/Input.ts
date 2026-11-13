import { DateTime, Effect, Option, Schema } from "effect"
import type { DaemonContract } from "@exangelos/contracts"
import { Ids, Session } from "@exangelos/domain"

export class InputInvalid extends Schema.TaggedError<InputInvalid>()("InputInvalid", {
  message: Schema.String
}) {}

const invalid = (message: string) => Effect.fail(new InputInvalid({ message }))

export const pairs = (args: ReadonlyArray<string>): Effect.Effect<Record<string, string>, InputInvalid> => {
  const result: Record<string, string> = {}
  for (const arg of args) {
    const at = arg.indexOf("=")
    if (at <= 0) {
      return invalid(`"${arg}" is not a key=value pair. Write each parameter as key=value, for example repo=acme/app.`)
    }
    const key = arg.slice(0, at)
    if (Object.hasOwn(result, key)) return invalid(`The key "${key}" is given twice. Give each key once.`)
    result[key] = arg.slice(at + 1)
  }
  return Effect.succeed(result)
}

export const subscriptionId = (raw: string): Effect.Effect<Ids.SubscriptionId, InputInvalid> =>
  Schema.decodeEffect(Ids.SubscriptionId)(raw).pipe(
    Effect.mapError(() =>
      new InputInvalid({
        message: `"${raw}" is not a subscription id. Ids look like sub_7f3k; run \`exangelos list\` to see yours.`
      })
    )
  )

export const connectorName = (raw: string): Effect.Effect<Ids.ConnectorName, InputInvalid> =>
  Schema.decodeEffect(Ids.ConnectorName)(raw).pipe(
    Effect.mapError(() =>
      new InputInvalid({
        message: `"${raw}" is not a connector name. Names use lowercase letters, digits and dashes; run \`exangelos connectors\` to see them.`
      })
    )
  )

export const eventTypes = (
  raw: Option.Option<string>
): Effect.Effect<readonly [Ids.EventType, ...Array<Ids.EventType>] | undefined, InputInvalid> =>
  Option.match(raw, {
    onNone: () => Effect.undefined,
    onSome: (text) =>
      Schema.decodeUnknownEffect(Schema.NonEmptyArray(Ids.EventType))(
        text.split(",").map((part) => part.trim()).filter((part) => part.length > 0)
      ).pipe(
        Effect.mapError(() =>
          new InputInvalid({
            message: `"${text}" is not a list of event types. Separate them with commas, for example --types checks.failed,review.submitted.`
          })
        )
      )
  })

export const similarOk = (raw: Option.Option<string>): Effect.Effect<Array<Ids.SubscriptionId>, InputInvalid> =>
  Option.match(raw, {
    onNone: () => Effect.succeed([]),
    onSome: (text) =>
      Effect.forEach(text.split(",").map((part) => part.trim()).filter((part) => part.length > 0), subscriptionId)
  })

export const until = (raw: Option.Option<string>): Effect.Effect<DateTime.Utc | undefined, InputInvalid> =>
  Option.match(raw, {
    onNone: () => Effect.undefined,
    onSome: (text) =>
      Option.match(DateTime.make(text), {
        onNone: () =>
          invalid(`"${text}" is not a time. Give an ISO 8601 time, for example --until 2026-11-20T18:00:00Z.`),
        onSome: (time) => Effect.succeed(DateTime.toUtc(time))
      })
  })

export const maxEvents = (options: {
  readonly maxEvents: Option.Option<number>
  readonly once: boolean
}): Effect.Effect<number | undefined, InputInvalid> => {
  if (options.once && Option.isSome(options.maxEvents)) return invalid("Give either --once or --max-events, not both.")
  if (options.once) return Effect.succeed(1)
  return Option.match(options.maxEvents, {
    onNone: () => Effect.undefined,
    onSome: (count) => count >= 1 ? Effect.succeed(count) : invalid("--max-events takes a number of 1 or more.")
  })
}

const isHarness = Schema.is(Session.Harness)

export const target = (options: {
  readonly target: Option.Option<string>
  readonly pullOnly: boolean
}): Effect.Effect<DaemonContract.TargetChoice, InputInvalid> => {
  if (options.pullOnly && Option.isSome(options.target)) return invalid("Give either --target or --pull-only, not both.")
  if (options.pullOnly) return Effect.succeed({ _tag: "PullOnly" })
  if (Option.isNone(options.target)) return Effect.succeed({ _tag: "Caller" })
  const text = options.target.value
  const at = text.indexOf(":")
  const harness = text.slice(0, at)
  const sessionId = text.slice(at + 1)
  return at > 0 && isHarness(harness) && sessionId.length > 0
    ? Effect.succeed({ _tag: "Session", session: { harness, sessionId } })
    : invalid(
      `"${text}" is not a wake target. Write it as <harness>:<session-id>, where the harness is t3, claude-code or codex.`
    )
}
