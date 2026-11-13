import { Array as Arr, Option } from "effect"
import type { RpcClientError } from "effect/rpc"
import type { DaemonContract } from "@exangelos/contracts"
import type { DaemonClient } from "@exangelos/daemon-client"
import { Refusal, type Subscription } from "@exangelos/domain"

export type AnyRefusal =
  | Refusal.IntentRequired
  | Refusal.ConnectorUnavailable
  | Refusal.NoWakeTarget
  | Refusal.ParametersInvalid
  | Refusal.SimilarSubscriptions
  | Refusal.SubjectChanged
  | Refusal.NotAllowed

export type AgentFailure =
  | DaemonContract.ConnectorNotFound
  | DaemonContract.ConnectorUnavailable
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
  | DaemonClient.DaemonNotRunning

export const wakeHint = (subscription: Subscription.Subscription): Option.Option<string> =>
  subscription.wakeTarget?.harness === "claude-code"
    ? Option.some(
      `Claude Code sessions don't receive wakes yet: run \`exangelos wait ${subscription.id}\` as a background command; it returns when there is something to say.`
    )
    : Option.none()

export const noDaemonMessage = (reason: string): string =>
  `No Exangelos daemon is running, and starting it failed: ${reason}. Run \`exangelos daemon\` in a terminal to start it in the foreground, then retry this call.`

export const connectionFailedMessage = (message: string): string =>
  `The connection to the Exangelos daemon failed: ${message}. Retry; if it keeps failing, restart the daemon with \`exangelos daemon\`.`

const parameterValue = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value)

export const similarLine = (match: Refusal.SimilarMatch): string =>
  `  ${match.id}  parameters: ${
    Object.entries(match.parameters).map(([key, value]) => `${key}=${parameterValue(value)}`).join(", ")
  }`

export const refusalMessage = (refusal: AnyRefusal): string => {
  switch (refusal._tag) {
    case "IntentRequired":
      return `Nothing was created: ${refusal.message}. Call subscribe again with an intent saying why you want these events.`
    case "ConnectorUnavailable":
      return `Connector ${refusal.connector} is unavailable: ${refusal.problem}. Ask the user to fix the connector, then retry.`
    case "NoWakeTarget":
      return "No session to wake was found for this call. Pass target: { harness, sessionId } to wake a specific session, or pullOnly: true to collect events with wait."
    case "ParametersInvalid":
      return `The parameters do not fit the connector: ${refusal.reason}. Call list_connectors to see the connector's parameter schema, then retry.`
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
    case "NotAllowed":
      return `A ${refusal.state} subscription cannot ${refusal.action}. Call show to see its state.`
  }
}

export const failureMessage = (failure: AgentFailure, subscription = "<subscription>"): string => {
  switch (failure._tag) {
    case "ConnectorNotFound":
      return `No connector named "${failure.connector}" is installed. Call list_connectors to see the installed connectors, or ask the user to import this one.`
    case "ConnectorUnavailable":
      return refusalMessage(new Refusal.ConnectorUnavailable({ connector: failure.connector, problem: failure.problem }))
    case "OfficialFetchFailed":
      return `Fetching the official connector ${failure.connector} failed: ${failure.reason}. Check the network connection, then retry.`
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
      return `Not resumed: ${failure.pending} events are pending, ${
        failure.reason === "count" ? `over the limit of ${failure.limit}` : "and the oldest is older than the backlog allows"
      }. Acknowledge them first: call ack with id: "${subscription}", through: ${failure.through}, then call resume.`
    case "RpcClientError":
      return connectionFailedMessage(failure.message)
    case "DaemonNotRunning":
      return noDaemonMessage(failure.reason)
  }
}
