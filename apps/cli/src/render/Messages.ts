import type { Catalogue, Refusal, Subscription } from "@exangelos/domain"
import { WakeText } from "@exangelos/contracts"

const command = WakeText.command

export const parameterValue = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value)

export const parametersText = (parameters: Catalogue.Parameters): string =>
  Object.entries(parameters).map(([key, value]) => `${key}=${parameterValue(value)}`).join(", ")

export const noDaemonMessage = (reason: string): string =>
  `No Exangelos daemon is running, and starting it failed: ${reason}. Run \`${command} daemon\` in a terminal to start it in the foreground, then retry this command.`

export const connectionFailedMessage = (message: string): string =>
  `The connection to the Exangelos daemon failed: ${message}. Retry; if it keeps failing, restart the daemon with \`${command} daemon\`.`

export const similarSubscriptionsMessage = (matches: ReadonlyArray<Refusal.SimilarMatch>): string =>
  [
    "Nothing was created: this session already has a similar open subscription.",
    ...matches.map((match) => `  ${match.id}  parameters: ${parametersText(match.parameters)}`),
    `If you still want a separate subscription, run the same command again with --similar-ok ${
      matches.map((match) => match.id).join(",")
    }.`
  ].join("\n")

export const backlogOverLimitMessage = (
  id: string,
  refusal: { readonly pending: number; readonly through?: number | undefined }
): string => {
  const pending = `${refusal.pending} ${refusal.pending === 1 ? "event is" : "events are"} pending`
  return refusal.through === undefined
    ? `Nothing was resumed: ${pending}, over the backlog limit. Read them with \`${command} events ${id}\`, acknowledge them with \`${command} ack ${id} --through <number>\`, then resume.`
    : `Nothing was resumed: ${pending}, over the backlog limit. Acknowledge them first with \`${command} ack ${id} --through ${refusal.through}\`, then resume.`
}

export const noWakeTargetMessage =
  `This command did not run inside a known agent session, so there is no session to wake. Pass --target <harness>:<session-id> to name one, or --pull-only to collect events with \`${command} wait\`.`

export const wakeHint = (subscription: Subscription.Subscription): string | undefined =>
  subscription.wakeTarget?.harness === "claude-code"
    ? `Claude Code sessions don't receive wakes yet: run \`${command} wait ${subscription.id}\` as a background command; it returns when there is something to say.`
    : undefined
