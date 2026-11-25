import { DateTime, Duration } from "effect"
import type { DaemonContract } from "@exangelos/contracts"
import type { Event, Connector, Session, Settings, Subscription } from "@exangelos/domain"
import { parameterValue, parametersText, wakeHint } from "./Messages.ts"

const time = (value: DateTime.Utc): string => DateTime.formatIso(value)

const fields = (rows: ReadonlyArray<readonly [string, string | undefined]>, indent = ""): Array<string> => {
  const present = rows.filter((row): row is readonly [string, string] => row[1] !== undefined)
  const width = Math.max(0, ...present.map(([label]) => label.length)) + 3
  return present.map(([label, value]) => `${indent}${`${label}:`.padEnd(width)}${value}`)
}

const columns = (rows: ReadonlyArray<ReadonlyArray<string>>, indent = ""): Array<string> => {
  const widths = rows.reduce<Array<number>>(
    (acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)),
    []
  )
  return rows.map((row) =>
    `${indent}${row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd((widths[index] ?? 0) + 2)).join("")}`
      .trimEnd()
  )
}

const sessionText = (session: Session.Target): string => `${session.harness}:${session.sessionId}`

const actorText = (actor: Session.Actor): string => actor._tag === "You" ? "you" : sessionText(actor.session)

export const stateText = (state: Subscription.State): string => {
  switch (state._tag) {
    case "Active":
      return "active"
    case "Paused":
      switch (state.reason._tag) {
        case "BacklogCount":
          return `paused (backlog reached ${state.reason.limit} events)`
        case "BacklogAge":
          return `paused (an event waited ${Duration.format(state.reason.limit)})`
        case "Actor":
          return `paused by ${actorText(state.reason.actor)}`
      }
      break
    case "Expired":
      return "expired"
    case "Ended":
      return state.reason._tag === "MaxEvents"
        ? "ended (reached its number of events)"
        : `ended by the connector: ${state.reason.reason}`
    case "Cancelled":
      return `cancelled by ${actorText(state.actor)}`
  }
}

const pending = (subscription: Subscription.Subscription): number =>
  subscription.lastNumber - subscription.ackedThrough

const observationReasons: Record<Connector.ObservationCategory, string> = {
  unavailable: "source unavailable. Check the source application and connector configuration",
  unreadable: "source could not be read. Check the configured location and read permissions",
  "invalid-data": "source or checkpoint could not be validated. Check source availability and connector compatibility",
  "scope-changed": "saved source identity could not be verified. Check the configured location and reselect the source if it changed"
}

const observationText = (observation: NonNullable<Subscription.Listed["observation"]>): string =>
  `failing since ${time(observation.since)}: ${observationReasons[observation.category]}`

const subscriptionRow = (subscription: Subscription.Listed): Array<string> => [
  subscription.id,
  subscription.connector,
  subscription.subject,
  subscription.observation === undefined
    ? stateText(subscription.state)
    : `${stateText(subscription.state)}, failing (${subscription.observation.category})`,
  `${pending(subscription)} pending`
]

export const subscription = (subscription: Subscription.Listed | Subscription.Shown): string =>
  fields([
    ["Subscription", subscription.id],
    ["Connector", subscription.connector],
    ["Subject", subscription.subject],
    ["Intent", subscription.intent],
    ["Parameters", parametersText(subscription.parameters) || undefined],
    ["Event types", subscription.eventTypes?.join(", ") ?? "all"],
    ["State", `${stateText(subscription.state)} since ${time(subscription.stateSince)}`],
    ["Observation", subscription.observation === undefined ? undefined : observationText(subscription.observation)],
    [
      "Failure",
      subscription.observation !== undefined && "reason" in subscription.observation ? subscription.observation.reason : undefined
    ],
    ["Wakes", subscription.wakeTarget === undefined ? "none (pull-only)" : sessionText(subscription.wakeTarget)],
    ["Event alerts", subscription.eventAlerts ? "on" : "off"],
    ["Events", `${subscription.lastNumber} received, acknowledged through ${subscription.ackedThrough}`],
    ["Max events", subscription.maxEvents?.toString()],
    ["Created", time(subscription.createdAt)],
    ["Expires", time(subscription.expiresAt)]
  ]).join("\n")

export const subscriptions = (list: ReadonlyArray<Subscription.Listed>): string =>
  list.length === 0 ? "No subscriptions." : columns(list.map(subscriptionRow)).join("\n")

const eventLines = (event: Event.Event): Array<string> => [
  `#${event.number} ${event.type}  ${time(event.occurredAt)}`,
  `  ${event.summary}`,
  ...(event.link === undefined ? [] : [`  ${event.link}`]),
  ...(event.payload === undefined ? [] : [`  payload: ${JSON.stringify(event.payload)}`])
]

export const events = (list: ReadonlyArray<Event.Event>): string =>
  list.length === 0 ? "No stored events." : list.flatMap(eventLines).join("\n")

export const details = (value: DaemonContract.Details): string => {
  const eventSummary = value.events.map((event) => [`#${event.number}`, event.type, event.summary])
  const wakes = value.wakes.map((wake) => [
    wake.id,
    wake.reason,
    `through #${wake.through}`,
    wake.state,
    `${wake.attempts.count} attempts${wake.attempts.lastError === undefined ? "" : `, last error: ${wake.attempts.lastError}`}`
  ])
  const changes = value.changes.map((change) => [
    time(change.at),
    change.kind,
    actorText(change.actor),
    change.detail ?? ""
  ])
  const section = (title: string, rows: ReadonlyArray<ReadonlyArray<string>>): Array<string> =>
    rows.length === 0 ? [] : ["", `${title}:`, ...columns(rows, "  ")]
  return [
    subscription(value.subscription),
    ...section("Events", eventSummary),
    ...section("Wakes", wakes),
    ...section("Changes", changes)
  ].join("\n")
}

export const origin = (origin: Connector.Origin): string => {
  switch (origin._tag) {
    case "Official":
      return `official ${origin.version}`
    case "ArchiveFile":
      return `archive ${origin.path}`
    case "HttpsLink":
      return origin.url
    case "Directory":
      return `directory ${origin.path}`
    case "GitRepository":
      return `git ${origin.url} at ${origin.ref}`
    case "DevLink":
      return `dev link ${origin.path}`
  }
}

const configurationText = (configuration: Connector.Configuration): string => {
  switch (configuration._tag) {
    case "Missing":
      return "not configured"
    case "Set":
      return "configured"
    case "Rejected":
      return `rejected: ${configuration.reason}`
  }
}

export const connectors = (list: ReadonlyArray<Connector.Connector>): string =>
  list.length === 0
    ? "No connectors installed."
    : columns(list.map((connector) => [
      connector.name,
      connector.version,
      connector.trust,
      configurationText(connector.configuration),
      connector.process,
      connector.catalogue === undefined ? "" : connector.catalogue.eventTypes.map((spec) => spec.type).join(", ")
    ])).join("\n")


export const connector = (connector: Connector.Status): string => {
  const catalogue = connector.catalogue
  const observation = connector.observation
  const lines = fields([
    ["Connector", `${connector.name} ${connector.version}`],
    ["Origin", origin(connector.origin)],
    ["Checksum", connector.digest],
    ["Trust", connector.trust],
    ["Configuration", configurationText(connector.configuration)],
    ["Configured by", connector.configuredBy === undefined ? undefined : actorText(connector.configuredBy)],
    ["Process", connector.process],
    ["Observation", observation === undefined ? undefined : [
      observation.categories.map((category) => observationReasons[category]).join("; "),
      `(${observation.affectedWatches} ${observation.affectedWatches === 1 ? "watch" : "watches"} affected)`
    ].join(" ")],
    ["Unavailable since", connector.unavailableSince === undefined ? undefined : time(connector.unavailableSince)],
    ["Main parameter", catalogue?.parameters.main],
    [
      "Parameters schema",
      catalogue === undefined || Object.keys(catalogue.parameters.schema).length === 0
        ? undefined
        : JSON.stringify(catalogue.parameters.schema)
    ]
  ])
  if (catalogue === undefined) return lines.join("\n")
  const fieldsTable = catalogue.configuration.map((field) => [
    field.key,
    field._tag === "Choice" ? `one of ${field.choices.join(", ")}` : field._tag.toLowerCase(),
    field.required ? "required" : "optional",
    field.label
  ])
  return [
    ...lines,
    "",
    "Event types:",
    ...columns(catalogue.eventTypes.map((spec) => [spec.type, spec.description]), "  "),
    ...(fieldsTable.length === 0 ? [] : ["", "Configuration fields:", ...columns(fieldsTable, "  ")])
  ].join("\n")
}

export const settings = (value: Settings.Settings): string =>
  fields([
    ["eventAlerts", String(value.eventAlerts)],
    ...Object.entries(value.limits).map(([key, limit]) =>
      [`limits.${key}`, Duration.isDuration(limit) ? Duration.format(limit) : parameterValue(limit)] as const
    ),
    ["officialConnectorFolder", value.officialConnectorFolder],
    ["logLevel", value.logLevel ?? "info"],
    ...Object.entries(value.harnesses).map(([name, harness]) => [`harnesses.${name}`, commandText(harness.command)] as const)
  ]).join("\n")

export const commandText = (command: ReadonlyArray<string>): string =>
  command.map((arg) => /^[^\s"'\\]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ")

export const serviceStatus = (status: { readonly version: string; readonly startMethod: string }): string =>
  fields([["Daemon", "running"], ["Version", status.version], ["Start method", status.startMethod]]).join("\n")

export const hinted = (text: (subscription: Subscription.Subscription) => string) =>
(subscription: Subscription.Subscription): string => {
  const hint = wakeHint(subscription)
  return hint === undefined ? text(subscription) : `${text(subscription)}\n${hint}`
}

export const hintedJson = (subscription: Subscription.Subscription, encoded: unknown): unknown => {
  const hint = wakeHint(subscription)
  return hint === undefined ? encoded : Object.assign({}, encoded, { hint })
}
