import { DateTime, Duration } from "effect"
import type { Session, Subscription, Wake } from "@exangelos/domain"

export const command = "exangelos"

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`

const durationText = (duration: Duration.Duration): string => {
  const seconds = Math.round(Duration.toSeconds(duration))
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour")
  if (seconds % 60 === 0) return plural(seconds / 60, "minute")
  return plural(seconds, "second")
}

const actorText = (actor: Session.Actor): string =>
  actor._tag === "You" ? "you" : `${actor.session.harness} session ${actor.session.sessionId}`

const pauseText = (reason: Subscription.PauseReason, pending: ReadonlyArray<Wake.PendingLine>): string => {
  switch (reason._tag) {
    case "BacklogCount":
      return `${reason.limit} events are pending. Nothing is watched while paused.`
    case "BacklogAge":
      return `Event #${pending[0]?.number ?? "?"} has been pending for ${durationText(reason.limit)}. Nothing is watched while paused.`
    case "Actor":
      return `Paused by ${actorText(reason.actor)}. Nothing is watched while paused.`
  }
}

const endText = (reason: Subscription.EndReason): string =>
  reason._tag === "MaxEvents" ? "It reached its number of events." : `The connector ended it: ${reason.reason}`

const table = (rows: ReadonlyArray<readonly [string, string]>, indent: string, gap: number): Array<string> => {
  const width = Math.max(...rows.map(([left]) => left.length)) + gap
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}${right}`.trimEnd())
}

export const render = (content: Wake.WakeContent): string => {
  const { pending, subscription: id } = content
  const where = `(${content.connector}, ${content.subject})`
  const through = pending.at(-1)?.number
  const read: readonly [string, string] = ["Read", `${command} events ${id}`]
  const ack: ReadonlyArray<readonly [string, string]> = through === undefined
    ? []
    : [["Ack", `${command} ack ${id} --through ${through}`]]
  const resume: readonly [string, string] = ["Resume", `${command} resume ${id}`]
  const eventLines = () => table(pending.map((line) => [`#${line.number} ${line.type}`, line.summary] as const), "  ", 3)
  const why = content.why
  const lines: Array<string> = []
  let commands: ReadonlyArray<readonly [string, string]>
  switch (why._tag) {
    case "Events":
      lines.push(`${pending.length} ${pending.length === 1 ? "event" : "events"} on ${id} ${where}`)
      lines.push(...eventLines())
      commands = [read, ...ack]
      break
    case "Paused":
      lines.push(`${id} is paused ${where}`, pauseText(why.reason, pending))
      commands = [...ack, resume]
      break
    case "Expired":
      lines.push(`${id} has expired ${where}`, "Nothing is watched until it is resumed.")
      commands = [...ack, resume]
      break
    case "Ended":
      lines.push(`${id} has ended ${where}`, endText(why.reason))
      if (why.reason._tag === "MaxEvents") lines.push(...eventLines())
      commands = through === undefined ? [] : [read, ...ack]
      break
    case "Cancelled":
      lines.push(`${id} was cancelled ${where}`, `Cancelled by ${actorText(why.actor)}.`)
      commands = through === undefined ? [] : [read, ...ack]
      break
    case "Suspended":
      lines.push(
        `${id} is suspended ${where}`,
        `${content.connector} has been unavailable since ${DateTime.formatIso(why.since)}: ${why.problem}. It continues by itself when the connector returns.`
      )
      commands = through === undefined ? [] : [read, ...ack]
      break
    case "Failing":
      lines.push(
        `${id} cannot be watched ${where}`,
        `${content.connector} has failed to read it since ${DateTime.formatIso(why.since)} (${why.category}): ${why.reason}`,
        "The daemon keeps retrying and sends one more wake when it recovers."
      )
      if (through !== undefined) lines.push(...eventLines())
      commands = through === undefined ? [] : [read, ...ack]
      break
    case "Recovered":
      lines.push(`${id} is watched again ${where}`, `${content.connector} reads it again and continues from its cursor.`)
      if (through !== undefined) lines.push(...eventLines())
      commands = through === undefined ? [] : [read, ...ack]
      break
  }
  return [...lines, ...(commands.length === 0 ? [] : table(commands, "", 2))].join("\n")
}
