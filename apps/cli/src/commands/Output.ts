import { Console, Data, Effect, Schema } from "effect"
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

const command = WakeText.command

export const Json = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print one JSON document on stdout, for agents and scripts")
  )
})

export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly tag: string }> {}

const ContractError = Schema.Union([
  DaemonContract.PluginNotFound,
  DaemonContract.PluginUnavailable,
  DaemonContract.SubscriptionNotFound,
  DaemonContract.InvalidRequest,
  DaemonContract.NoWakeTarget,
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
    case "InputInvalid":
      return failure.message
    case "PluginNotFound":
      return `No plugin named ${failure.plugin} is installed. Run \`${command} plugins\` to see the installed plugins.`
    case "PluginUnavailable":
      return `${failure.plugin} is unavailable: ${failure.problem}. Run \`${command} plugins ${failure.plugin}\` to see its state.`
    case "SubscriptionNotFound":
      return `No subscription ${failure.id}. Run \`${command} list --all\` to see every subscription.`
    case "InvalidRequest":
      return failure.message
    case "NoWakeTarget":
      return noWakeTargetMessage
    case "ParametersInvalid":
      return `The plugin refused the parameters: ${failure.reason}. Run \`${command} plugins <plugin>\` to see what it takes.`
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
      return `Fetching the official plugin ${failure.plugin} failed: ${failure.reason}. Check the network connection, then retry.`
    case "ImportFailed":
      return `The import failed: ${failure.reason}. Check the source, then retry.`
    case "DigestMismatch":
      return `The files of ${failure.plugin} changed: its checksum is ${failure.actual}, not ${failure.expected}. Nothing was enabled; run \`${command} plugin enable ${failure.plugin}\` to review the new checksum.`
    case "HumanRequired":
      return `Only you can do this${
        failure.plugin !== undefined ? ` for ${failure.plugin}` : failure.subscription !== undefined ? ` for ${failure.subscription}` : ""
      }, and this terminal runs inside an agent session. Run the command again from your own terminal.`
    case "ConfigurationInvalid":
      return `The configuration does not fit the plugin's catalogue: ${failure.reason}. Run \`${command} plugins <plugin>\` to see its fields.`
    case "ConfigurationRejected":
      return `The plugin rejected the configuration: ${failure.reason}. Check the values, then run \`${command} plugin configure\` again.`
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
          return Effect.andThen(
            json ? Console.log(JSON.stringify(failureJson(failure, message))) : Console.error(message),
            Effect.fail(new CommandFailed({ tag: failure._tag }))
          )
        }
      })
    )
  })
