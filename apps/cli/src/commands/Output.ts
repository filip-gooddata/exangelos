import { Console, Data, Effect, Runtime, Schema } from "effect"
import { Flag, GlobalFlag } from "effect/cli"
import type { RpcClientError } from "effect/rpc"
import { DaemonContract, WakeText } from "@exangelos/contracts"
import { DaemonClient } from "@exangelos/daemon-client"
import {
  backlogOverLimitMessage,
  connectionFailedMessage,
  noDaemonMessage,
  noWakeTargetMessage,
  similarSubscriptionsMessage
} from "../render/Messages.ts"
import { InputInvalid } from "./Input.ts"
import { DaemonUnreachable } from "./Reconnect.ts"

const command = WakeText.command

export const Json = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print one JSON document on stdout, for agents and scripts")
  )
})

export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly tag: string; readonly exitCode?: number | undefined }> {
  override get [Runtime.errorExitCode](): number {
    return this.exitCode ?? 1
  }
}

const ContractError = Schema.Union([
  DaemonContract.ConnectorNotFound,
  DaemonContract.ConnectorUnavailable,
  DaemonContract.SubscriptionNotFound,
  DaemonContract.InvalidRequest,
  DaemonContract.NoWakeTarget,
  DaemonContract.UnknownHarness,
  DaemonContract.ParametersInvalid,
  DaemonContract.SimilarSubscriptions,
  DaemonContract.SubjectChanged,
  DaemonContract.TransitionRefused,
  DaemonContract.BacklogOverLimit,
  DaemonContract.OfficialFetchFailed,
  DaemonContract.ImportFailed,
  DaemonContract.DigestMismatch,
  DaemonContract.HumanRequired,
  DaemonContract.ConfigurationInvalid,
  DaemonContract.ConfigurationRejected,
  DaemonClient.DaemonNotRunning,
  DaemonUnreachable,
  InputInvalid
])
type ContractError = typeof ContractError.Type

export type Failure = ContractError | RpcClientError.RpcClientError

const encodeContractError = Schema.encodeSync(Schema.toCodecJson(ContractError))

export const failureMessage = (failure: Failure, subscription?: string): string => {
  switch (failure._tag) {
    case "RpcClientError":
      return connectionFailedMessage(failure.message)
    case "DaemonNotRunning":
      return noDaemonMessage(failure.reason)
    case "DaemonUnreachable":
      return `The Exangelos daemon has not answered for ${failure.waited} (${failure.reason}), so this gave up. Run \`${command} service status\` to check it, then retry.`
    case "InputInvalid":
      return failure.message
    case "ConnectorNotFound":
      return `No connector named ${failure.connector} is installed. Run \`${command} connectors\` to see the installed connectors.`
    case "ConnectorUnavailable":
      return `${failure.connector} is unavailable: ${failure.problem}. Run \`${command} connectors ${failure.connector}\` to see its state.`
    case "SubscriptionNotFound":
      return `No subscription ${failure.id}. Run \`${command} list --all\` to see every subscription.`
    case "InvalidRequest":
      return failure.message
    case "NoWakeTarget":
      return noWakeTargetMessage
    case "UnknownHarness":
      return failure.message
    case "ParametersInvalid":
      return `The connector refused the parameters: ${failure.reason}. Run \`${command} connectors <connector>\` to see what it takes.`
    case "SimilarSubscriptions":
      return similarSubscriptionsMessage(
        failure.similar.map((similar) => ({ id: similar.id, parameters: similar.parameters }))
      )
    case "SubjectChanged":
      return `These parameters name a different subject (${failure.to} instead of ${failure.from}), so nothing was changed. Cancel this subscription and subscribe again for the new subject.`
    case "TransitionRefused":
      return `${failure.message} The subscription is ${failure.state._tag.toLowerCase()}; run \`${command} show ${
        subscription ?? "<subscription>"
      }\` to see it.`
    case "BacklogOverLimit":
      return backlogOverLimitMessage(subscription ?? "<subscription>", failure)
    case "OfficialFetchFailed":
      return `Fetching the official connector ${failure.connector} failed: ${failure.reason}. Check the network connection, then retry.`
    case "ImportFailed":
      return `The import failed: ${failure.reason}. Check the source, then retry.`
    case "DigestMismatch":
      return `The files of ${failure.connector} changed: its checksum is ${failure.actual}, not ${failure.expected}. Nothing was enabled; run \`${command} connector enable ${failure.connector}\` to review the new checksum.`
    case "HumanRequired":
      if (failure.subscription !== undefined) {
        return `Only you or the session that created ${failure.subscription} can switch its event alerts, and this terminal runs inside another agent session. Run the command again from your own terminal or from that session.`
      }
      if (failure.settings !== undefined) {
        return "Only you change settings, and this terminal runs inside an agent session. Run the command again from your own terminal."
      }
      if (failure.harness !== undefined) {
        return "Only you define harnesses, and this terminal runs inside an agent session. Run the command again from your own terminal."
      }
      return `Only you can do this${
        failure.connector !== undefined ? ` for ${failure.connector}` : ""
      }, and this terminal runs inside an agent session. Run the command again from your own terminal.`
    case "ConfigurationInvalid":
      return `The configuration does not fit the connector's catalogue: ${failure.reason}. Run \`${command} connectors <connector>\` to see its fields.`
    case "ConfigurationRejected":
      return `The connector rejected the configuration: ${failure.reason}. Check the values, then run \`${command} connector configure\` again.`
  }
}

const failureJson = (failure: Failure, message: string): unknown =>
  failure._tag === "RpcClientError"
    ? { error: { _tag: failure._tag, message } }
    : { error: Object.assign({}, encodeContractError(failure), { message }) }

export const respond = <A, I, E extends Failure, R>(
  work: Effect.Effect<A, E, R>,
  options: {
    readonly schema: Schema.Codec<A, I>
    readonly text: (value: A) => string
    readonly json?: (value: A, encoded: unknown) => unknown
    readonly subscription?: string
    readonly exitCode?: (failure: E) => number | undefined
  }
): Effect.Effect<void, CommandFailed, R | GlobalFlag.Setting.Identifier<"json">> =>
  Effect.gen(function*() {
    const json = yield* Json
    yield* work.pipe(
      Effect.matchEffect({
        onSuccess: (value) => {
          if (!json) return Console.log(options.text(value))
          const encoded = Schema.encodeSync(Schema.toCodecJson(options.schema))(value)
          return Console.log(JSON.stringify(options.json ? options.json(value, encoded) : encoded))
        },
        onFailure: (failure) => {
          const message = failureMessage(failure, options.subscription)
          const exitCode = options.exitCode?.(failure)
          return Effect.andThen(
            json
              ? Effect.andThen(
                Console.log(JSON.stringify(failureJson(failure, message))),
                exitCode === undefined ? Effect.void : Console.error(message)
              )
              : Console.error(message),
            Effect.fail(new CommandFailed({ tag: failure._tag, exitCode }))
          )
        }
      })
    )
  })
