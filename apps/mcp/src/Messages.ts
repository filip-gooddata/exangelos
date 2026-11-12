import { Array as Arr } from "effect"
import type { RpcClientError } from "effect/rpc"
import type { DaemonContract } from "@exangelos/contracts"
import { Refusal } from "@exangelos/domain"

export type AnyRefusal =
  | Refusal.IntentRequired
  | Refusal.PluginUnavailable
  | Refusal.NoWakeTarget
  | Refusal.ParametersInvalid
  | Refusal.SimilarSubscriptions
  | Refusal.SubjectChanged
  | Refusal.BacklogOverLimit
  | Refusal.NotAllowed

export type AgentFailure =
  | DaemonContract.PluginNotFound
  | DaemonContract.PluginUnavailable
  | DaemonContract.OfficialFetchFailed
  | DaemonContract.InvalidRequest
  | DaemonContract.NoWakeTarget
  | DaemonContract.ParametersInvalid
  | DaemonContract.SimilarSubscriptions
  | DaemonContract.SubscriptionNotFound
  | DaemonContract.SubjectChanged
  | DaemonContract.TransitionRefused
  | DaemonContract.BacklogOverLimit
  | RpcClientError.RpcClientError

export const noDaemonMessage = (reason: string): string =>
  `No Exangelos daemon is running, and starting it failed: ${reason}. Run \`exangelos daemon\` in a terminal to start it in the foreground, then retry this call.`

const parameterValue = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value)

/** One line per similar subscription, the same line the CLI prints. */
export const similarLine = (match: Refusal.SimilarMatch): string =>
  `  ${match.id}  parameters: ${
    Object.entries(match.parameters).map(([key, value]) => `${key}=${parameterValue(value)}`).join(", ")
  }`

/** What the daemon refused and what the agent can do next. */
export const refusalMessage = (refusal: AnyRefusal): string => {
  switch (refusal._tag) {
    case "IntentRequired":
      return `Nothing was created: ${refusal.message}. Call subscribe again with an intent saying why you want these events.`
    case "PluginUnavailable":
      return `Plugin ${refusal.plugin} is unavailable: ${refusal.problem}. Ask the user to fix the plugin, then retry.`
    case "NoWakeTarget":
      return "No session to wake was found for this call. Pass target: { harness, sessionId } to wake a specific session, or pullOnly: true to collect events with wait."
    case "ParametersInvalid":
      return `The parameters do not fit the plugin: ${refusal.reason}. Call list_plugins to see the plugin's parameter schema, then retry.`
    case "SimilarSubscriptions":
      return [
        "Nothing was created: this session already has a similar open subscription.",
        ...refusal.matches.map(similarLine),
        `If you still want a separate subscription, call subscribe again with the same input plus similarOk: [${
          refusal.matches.map((match) => `"${match.id}"`).join(", ")
        }].`
      ].join("\n")
    case "SubjectChanged":
      return `Nothing was updated: the new parameters change the subject from ${refusal.subject} to ${refusal.reported}. Cancel this subscription and subscribe again for the new subject.`
    case "BacklogOverLimit":
      return `Not resumed: ${refusal.pending} events are pending. Acknowledge them first with ack through ${refusal.through}, then call resume.`
    case "NotAllowed":
      return `A ${refusal.state} subscription cannot ${refusal.action}. Call show to see its state.`
  }
}

/** Maps a draft contract failure to its message, through the domain refusal where the shapes agree. */
export const failureMessage = (failure: AgentFailure): string => {
  switch (failure._tag) {
    case "PluginNotFound":
      return `No plugin named "${failure.plugin}" is installed. Call list_plugins to see the installed plugins, or ask the user to import this one.`
    case "PluginUnavailable":
      return refusalMessage(new Refusal.PluginUnavailable({ plugin: failure.plugin, problem: failure.problem }))
    case "OfficialFetchFailed":
      return `Fetching the official plugin ${failure.plugin} failed: ${failure.reason}. Check the network connection, then retry.`
    case "InvalidRequest":
      return `The daemon refused the request: ${failure.message}. Correct the input, then retry.`
    case "NoWakeTarget":
      return refusalMessage(new Refusal.NoWakeTarget({}))
    case "ParametersInvalid":
      return refusalMessage(new Refusal.ParametersInvalid({ reason: failure.reason }))
    case "SimilarSubscriptions":
      return refusalMessage(
        new Refusal.SimilarSubscriptions({
          matches: Arr.map(failure.similar, ({ id, parameters }) => ({ id, parameters }))
        })
      )
    case "SubscriptionNotFound":
      return `There is no subscription ${failure.id}. Call list to see your subscriptions, or list with all: true to see every session's.`
    case "SubjectChanged":
      return refusalMessage(new Refusal.SubjectChanged({ subject: failure.from, reported: failure.to }))
    case "TransitionRefused":
      return `The subscription is ${failure.state._tag}, so this was refused: ${failure.message}. Call show to see its state.`
    case "BacklogOverLimit":
      return `Not resumed: ${failure.pending} events are pending, over the limit of ${failure.limit}. Call events to find the last number, acknowledge through it with ack, then call resume.`
    case "RpcClientError":
      return noDaemonMessage(failure.message)
  }
}
