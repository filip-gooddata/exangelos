import type { DaemonContract } from "@exangelos/contracts"
import type { Alert, Catalogue, Event, Connector, Session, Subscription, Wake } from "@exangelos/domain"
import { DateTime, Duration } from "effect"
import type { Detail, ServiceStatus } from "../daemon/DaemonClient.ts"
import type { Refusal } from "../state/Panel.ts"

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const millis = (at: DateTime.Utc) => DateTime.toEpochMillis(at)

const builtInNames: Record<Session.Harness, string> = { t3: "T3 Code", "claude-code": "Claude Code", codex: "Codex" }

export const harnessName = (harness: string): string =>
  Object.hasOwn(builtInNames, harness) ? builtInNames[harness as Session.Harness] : harness

/** A duration in the panel's terse units: "4 min", "3 h", "6 days". */
export const span = (ms: number): string => {
  const length = Math.abs(ms)
  if (length < hour) return `${Math.max(1, Math.round(length / minute))} min`
  if (length < day) return `${Math.round(length / hour)} h`
  const days = Math.round(length / day)
  return days === 1 ? "1 day" : `${days} days`
}

export const ago = (now: number, at: DateTime.Utc): string => {
  const ms = now - millis(at)
  if (ms < minute) return "just now"
  if (ms >= day && ms < 2 * day) return "yesterday"
  return `${span(ms)} ago`
}

export const until = (now: number, at: DateTime.Utc): string => {
  const ms = millis(at) - now
  return ms < minute ? "now" : `in ${span(ms)}`
}

/** The short time at the right edge of a row: "2 min", "3 h", "2 days". */
export const age = (now: number, at: DateTime.Utc): string => span(now - millis(at))

/** Session titles the daemon resolved through each harness, keyed by {@link titleKey}. */
export type Titles = ReadonlyMap<string, string>

export const noTitles: Titles = new Map()

export const titleKey = (target: Session.Target): string => `${target.harness}\u0000${target.sessionId}`

export const titlesFrom = (
  titles: ReadonlyArray<{ readonly harness: string; readonly sessionId: string; readonly title: string }>
): Titles => new Map(titles.map((t) => [titleKey(t), t.title] as const))

/** A long id cut to its first eight characters, for when no title is known. */
export const shortId = (id: string): string => (id.length <= 12 ? id : `${id.slice(0, 8)}…`)

/** The session's title when its harness told one, else its shortened id. */
export const sessionTitle = (target: Session.Target, titles: Titles): string =>
  titles.get(titleKey(target)) ?? shortId(target.sessionId)

/** The full identity of a session, for a tooltip. */
export const sessionHover = (target: Session.Target): string => `${harnessName(target.harness)} session ${target.sessionId}`

export const sessionName = (target: Session.Target, titles: Titles): string =>
  `${harnessName(target.harness)} · ${sessionTitle(target, titles)}`

export const actorName = (actor: Session.Actor, titles: Titles = noTitles): string =>
  actor._tag === "You" ? "you" : sessionName(actor.session, titles)

export const pending = (subscription: Subscription.Subscription): number =>
  subscription.lastNumber - subscription.ackedThrough

export const isOpen = (subscription: Subscription.Subscription): boolean =>
  subscription.state._tag === "Active" || subscription.state._tag === "Paused" || subscription.state._tag === "Expired"

/** The connector an active subscription waits on while that connector is unavailable. */
export const suspendedOn = (
  subscription: Subscription.Subscription,
  connectors: ReadonlyArray<Connector.Connector>
): Connector.Connector | undefined =>
  subscription.state._tag === "Active"
    ? connectors.find((connector) => connector.name === subscription.connector && connector.unavailableSince !== undefined)
    : undefined

/** The one-word tag next to a row's label, absent for a plain active subscription. */
export const stateTag = (subscription: Subscription.Subscription, suspended: boolean): string | undefined => {
  switch (subscription.state._tag) {
    case "Active":
      return suspended ? "Suspended" : undefined
    case "Paused":
      return "Paused"
    case "Expired":
      return "Expired"
    case "Ended":
      return "Ended"
    case "Cancelled":
      return "Cancelled"
  }
}

const pauseReason = (reason: Subscription.PauseReason, subscription: Subscription.Subscription, titles: Titles): string => {
  switch (reason._tag) {
    case "BacklogCount":
      return `the backlog reached ${reason.limit} pending events`
    case "BacklogAge":
      return `its oldest pending event passed ${span(Duration.toMillis(reason.limit))}`
    case "Actor":
      return `${actorName(reason.actor, titles)} paused it with ${pending(subscription)} pending`
  }
}

/** The state fact on a row's third line. */
export const stateFact = (
  now: number,
  subscription: Subscription.Subscription,
  suspended?: Connector.Connector,
  titles: Titles = noTitles
): string => {
  const { state, stateSince } = subscription
  switch (state._tag) {
    case "Active":
      return suspended?.unavailableSince !== undefined
        ? `Suspended ${ago(now, suspended.unavailableSince)}, ${suspended.name} is unavailable`
        : `Expires ${until(now, subscription.expiresAt)}`
    case "Paused":
      return state.reason._tag === "Actor"
        ? `Paused by ${actorName(state.reason.actor, titles)} ${ago(now, stateSince)}`
        : `Paused ${ago(now, stateSince)}: ${pauseReason(state.reason, subscription, titles)}`
    case "Expired":
      return `Expired ${ago(now, stateSince)}`
    case "Ended":
      return state.reason._tag === "MaxEvents"
        ? `Ended ${ago(now, stateSince)} after its last allowed event`
        : `Ended ${ago(now, stateSince)} by the connector: ${state.reason.reason}`
    case "Cancelled":
      return `Cancelled ${ago(now, stateSince)} by ${actorName(state.actor, titles)}`
  }
}

/** The state in whole sentences, for the top of one subscription. */
export const stateSentence = (
  now: number,
  subscription: Subscription.Subscription,
  suspended?: Connector.Connector,
  titles: Titles = noTitles
): string => {
  const { state, stateSince } = subscription
  const expires = `Expires ${until(now, subscription.expiresAt)}.`
  switch (state._tag) {
    case "Active":
      return suspended === undefined
        ? `Active. ${expires}`
        : `Active and suspended: ${suspended.name} is unavailable${
          suspended.unavailableSince === undefined ? "" : ` since ${ago(now, suspended.unavailableSince)}`
        }. It continues by itself when the connector returns. ${expires}`
    case "Paused":
      return `Paused ${ago(now, stateSince)}: ${pauseReason(state.reason, subscription, titles)}. Nothing is watched while paused. ${expires}`
    case "Expired":
      return `Expired ${ago(now, stateSince)}. Nothing is watched until someone resumes it.`
    case "Ended":
    case "Cancelled":
      return `${stateFact(now, subscription, undefined, titles)}.`
  }
}

const wakeReasons: Record<Wake.WakeReason, string> = {
  events: "events",
  paused: "paused itself",
  expired: "expired",
  suspended: "suspended",
  failing: "failing to read",
  recovered: "reading again",
  ended: "ended",
  cancelled: "cancelled"
}

const wakeStates: Record<Wake.WakeState, string> = {
  waiting: "Waiting",
  sending: "Sending",
  delivered: "Delivered",
  replaced: "Replaced",
  dropped: "Dropped"
}

export const wakeState = (wake: Wake.Wake): string => wakeStates[wake.state]

export const wakeReason = (wake: Wake.Wake): string =>
  wake.reason === "events" ? `Events through #${wake.through}` : `The subscription ${wakeReasons[wake.reason]}`

const isRetrying = (wake: Wake.Wake) =>
  (wake.state === "waiting" || wake.state === "sending") && wake.attempts.count > 0 && wake.attempts.lastError !== undefined

/** A wake the daemon keeps retrying: the quiet fact that its session does not answer. */
export const retryingWake = (detail: Detail | undefined): Wake.Wake | undefined => detail?.wakes.find(isRetrying)

/** What a retrying wake records: its attempts and the time of the next one. */
export const retryFact = (now: number, wake: Wake.Wake): string => {
  const attempts = wake.attempts.count === 1 ? "1 attempt" : `${wake.attempts.count} attempts`
  const next = wake.attempts.nextAttemptAt === undefined ? "" : `, next ${until(now, wake.attempts.nextAttemptAt)}`
  return `Wake waiting, ${attempts}${next}`
}

const changeTitles: Readonly<Record<Subscription.ChangeKind, string>> = {
  create: "Created",
  update: "Updated",
  ack: "Acknowledged",
  pause: "Paused",
  resume: "Resumed",
  retarget: "Retargeted",
  cancel: "Cancelled",
  eventAlerts: "Event alerts"
}

export const changeTitle = (change: Subscription.Change): string =>
  change.kind === "eventAlerts"
    ? `Event alerts turned ${change.detail === "on" ? "on" : "off"}`
    : change.detail === undefined
    ? changeTitles[change.kind]
    : `${changeTitles[change.kind]}: ${change.detail}`

export interface HistoryEntry {
  readonly title: string
  readonly by: string
  readonly at: DateTime.Utc
}

/** Changes and wakes, newest first. A stop the daemon made itself has no change, so its wake carries it. */
export const history = (detail: Detail, titles: Titles = noTitles): ReadonlyArray<HistoryEntry> =>
  [
    ...detail.changes.map((change): HistoryEntry => ({
      title: changeTitle(change),
      by: `By ${actorName(change.actor, titles)}`,
      at: change.at
    })),
    ...detail.wakes.map((wake): HistoryEntry => ({
      title: `Wake: ${wakeReason(wake).toLowerCase()}`,
      by: `${wakeState(wake)}${wake.attempts.count > 1 ? `, ${wake.attempts.count} attempts` : ""}`,
      at: wake.createdAt
    }))
  ].sort((a, b) => millis(b.at) - millis(a.at))

export const pendingEvents = (detail: Detail): ReadonlyArray<Event.Event> =>
  detail.events.filter((event) => event.number > detail.subscription.ackedThrough).sort((a, b) => b.number - a.number)

export const acknowledgedEvents = (detail: Detail): ReadonlyArray<Event.Event> =>
  detail.events.filter((event) => event.number <= detail.subscription.ackedThrough).sort((a, b) => b.number - a.number)

/** The connector's logo as an image source, when its manifest names a valid icon. */
export const connectorIcon = (connectors: ReadonlyArray<Connector.Status>, name: string): string | undefined => {
  const icon = connectors.find((connector) => connector.name === name)?.icon
  return icon === undefined ? undefined : `data:${icon.mediaType};base64,${icon.data}`
}

/** What a row is called: the connector's label, else the agent's intent; never the raw subject, which only the tooltip and detail view show. */
export const rowLabel = (subscription: Subscription.Subscription): string =>
  subscription.label === "" ? subscription.intent : subscription.label

/** What a row's tooltip tells beyond its label: the connector, the raw subject and the expiry. */
export const rowHover = (now: number, subscription: Subscription.Subscription): string =>
  [
    `${subscription.connector}: ${subscription.subject}`,
    ...(isOpen(subscription) ? [`Expires ${until(now, subscription.expiresAt)}`] : [])
  ].join("\n")

/** The row's quiet third line: the state when it is not plainly active, an expiry within a day, else nothing. */
export const rowFact = (
  now: number,
  subscription: Subscription.Subscription,
  suspended: Connector.Connector | undefined,
  titles: Titles
): string | undefined =>
  subscription.state._tag !== "Active" || suspended !== undefined
    ? stateFact(now, subscription, suspended, titles)
    : millis(subscription.expiresAt) - now < day
    ? `Expires ${until(now, subscription.expiresAt)}`
    : undefined

export const connectorInitials = (name: string): string => {
  const parts = name.split(/[^a-z0-9]+/i).filter((part) => part.length > 0)
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)
  return letters.toUpperCase()
}

export const originSummary = (origin: Connector.Origin): string => {
  switch (origin._tag) {
    case "Official":
      return "Official release"
    case "ArchiveFile":
      return `Archive file ${origin.path}`
    case "HttpsLink":
      return `https link ${origin.url}`
    case "Directory":
      return `Directory ${origin.path}`
    case "GitRepository":
      return `Git repository at ${origin.ref}`
    case "DevLink":
      return `Dev link ${origin.path}`
  }
}

/** The origin as labelled rows, for the step where you read it before enabling. */
export const originRows = (origin: Connector.Origin): ReadonlyArray<readonly [string, string]> => {
  switch (origin._tag) {
    case "Official":
      return [["Source", "Official release"], ["Release", origin.version]]
    case "ArchiveFile":
      return [["Source", "Archive file"], ["Path", origin.path]]
    case "HttpsLink":
      return [["Source", "https link"], ["Link", origin.url]]
    case "Directory":
      return [["Source", "Directory"], ["Path", origin.path]]
    case "GitRepository":
      return [["Source", "Git repository"], ["Repository", origin.url], ["Ref", origin.ref]]
    case "DevLink":
      return [["Source", "Dev link"], ["Path", origin.path]]
  }
}

const capitalized = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`

export const trustText = (trust: Connector.Trust): string => capitalized(trust)

export const processText = (process: Connector.ProcessState): string => capitalized(process)

export const configurationFields = (connector: Connector.Connector): ReadonlyArray<Catalogue.ConfigurationField> =>
  connector.catalogue?.configuration ?? []

export const configurationText = (connector: Connector.Connector): string => {
  if (configurationFields(connector).length === 0 && connector.configuration._tag !== "Rejected") return "None needed"
  switch (connector.configuration._tag) {
    case "Missing":
      return "Missing"
    case "Set":
      return "Set"
    case "Rejected":
      return "Rejected by the source"
  }
}

/** A field whose value goes to the system keychain, so the panel never shows it. */
export const isSecretField = (field: Catalogue.ConfigurationField): boolean =>
  field._tag === "Secret" || field.secretDestination

/**
 * Whether a secret is stored, when the connector record can tell: a required field of a complete configuration is set.
 * The record has no presence per field, so an optional secret, or any secret of an incomplete configuration, stays unknown.
 */
export const secretStored = (connector: Connector.Connector, field: Catalogue.ConfigurationField): true | undefined =>
  connector.configuration._tag !== "Missing" && field.required ? true : undefined

export const knownSessions = (subscriptions: ReadonlyArray<Subscription.Subscription>): ReadonlyArray<Session.Target> =>
  subscriptions.reduce<ReadonlyArray<Session.Target>>((sessions, subscription) => {
    const target = subscription.wakeTarget
    return target === undefined || sessions.some((s) => s.harness === target.harness && s.sessionId === target.sessionId)
      ? sessions
      : [...sessions, target]
  }, [])

export const ackThroughNumber = (subscription: Subscription.Subscription, chosen: number | null): number | undefined => {
  if (subscription.lastNumber <= subscription.ackedThrough) return undefined
  return chosen !== null && chosen > subscription.ackedThrough && chosen <= subscription.lastNumber
    ? chosen
    : subscription.lastNumber
}

export const shortDigest = (digest: string): string => {
  const hex = digest.replace(/^sha256[:-]?/, "")
  return hex.length <= 14 ? `sha256 ${hex}` : `sha256 ${hex.slice(0, 8)}…${hex.slice(-4)}`
}

export const importSource = (
  kind: "ArchiveFile" | "HttpsLink" | "Directory" | "GitRepository",
  location: string,
  ref: string
): DaemonContract.ImportSource | undefined => {
  const at = location.trim()
  if (at === "") return undefined
  switch (kind) {
    case "ArchiveFile":
    case "Directory":
      return { _tag: kind, path: at }
    case "HttpsLink":
      return { _tag: kind, url: at }
    case "GitRepository":
      return ref.trim() === "" ? undefined : { _tag: kind, url: at, ref: ref.trim() }
  }
}

export const filledValues = (
  fields: ReadonlyArray<Catalogue.ConfigurationField>,
  edits: Readonly<Record<string, string>>
): Catalogue.ConfigurationValues =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const edit = edits[field.key]
      const value = field._tag === "Text" && !field.secretDestination ? edit?.trim() : edit
      return value === undefined || value === "" ? [] : [[field.key, value] as const]
    })
  )

export const startMethodText: Record<ServiceStatus["startMethod"], string> = {
  homebrew: "Started by its Homebrew service",
  "launch-agent": "Started at login by launchd",
  "systemd-user": "Started by its systemd user service",
  foreground: "Started in a terminal, in the foreground"
}

export interface NeedsYouItem {
  readonly connector: string
  readonly title: string
  readonly detail: string
  readonly action: string
}

const suspendedCount = (connector: string, subscriptions: ReadonlyArray<Subscription.Subscription>) => {
  const count = subscriptions.filter((s) => s.connector === connector && s.state._tag === "Active").length
  return count === 0 ? "" : count === 1 ? " One subscription is suspended." : ` ${count} subscriptions are suspended.`
}

export const needsYouItem = (
  now: number,
  alert: Alert.Alert,
  connectors: ReadonlyArray<Connector.Connector>,
  subscriptions: ReadonlyArray<Subscription.Subscription>
): NeedsYouItem => {
  const connector = connectors.find((p) => p.name === alert.connector)
  const since = connector?.unavailableSince === undefined ? "" : ` ${capitalized(ago(now, connector.unavailableSince))}.`
  switch (alert._tag) {
    case "CredentialsRejected":
      return {
        connector: alert.connector,
        title: `The source rejected the ${alert.connector} credentials.`,
        detail: `${alert.reason}.${since}${suspendedCount(alert.connector, subscriptions)}`.replace(/\.\./g, "."),
        action: "Enter credentials"
      }
    case "WaitsForEnable":
      return {
        connector: alert.connector,
        title: `${alert.connector} waits to be enabled.`,
        detail: `${connector === undefined ? "Imported" : originSummary(connector.origin)}. Inert until you enable it.`,
        action: "Enable"
      }
    case "Failing":
      return {
        connector: alert.connector,
        title: `${alert.connector} keeps failing.`,
        detail: `${alert.reason}.${since}${suspendedCount(alert.connector, subscriptions)}`.replace(/\.\./g, "."),
        action: "Open"
      }
    case "DigestMismatch":
      return {
        connector: alert.connector,
        title: `${alert.connector} does not match its official checksum.`,
        detail: "It stays inert. Remove it, and the daemon fetches it again when an agent needs it.",
        action: "Review"
      }
    case "Event":
      return { connector: alert.connector, title: `${alert.subject}: ${alert.event}`, detail: alert.subscription, action: "Open" }
  }
}

/** The sentence that tells you why the daemon or the tray app refused an action. */
export const refusalText = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case "BacklogOverLimit":
      return refusal.reason === "count"
        ? `The backlog holds ${refusal.pending} pending events, over the limit of ${refusal.limit}. Acknowledge through event ${refusal.through}, then resume.`
        : `The oldest of the ${refusal.pending} pending events is past the age limit. Acknowledge through event ${refusal.through}, then resume.`
    case "TransitionRefused":
    case "InvalidRequest":
    case "NoWakeTarget":
    case "UnknownHarness":
      return refusal.message
    case "SubscriptionNotFound":
      return `The daemon has no subscription ${refusal.id}.`
    case "ImportFailed":
      return `The import failed: ${refusal.reason}`
    case "ConnectorNotFound":
      return `The daemon has no connector ${refusal.connector}.`
    case "ConnectorUnavailable":
      return `${refusal.connector} is unavailable: ${refusal.problem}`
    case "DigestMismatch":
      return `${refusal.connector} changed after you read its checksum, so it stays inert. Read the new checksum before you enable it.`
    case "ConfigurationInvalid":
      return `The configuration is not valid: ${refusal.reason}`
    case "ConfigurationRejected":
      return `The source rejected this configuration: ${refusal.reason}`
    case "HumanRequired":
      return "Only you can do this, from the tray app or the CLI, not an agent."
    case "DaemonNotRunning":
      return `The daemon is not running: ${refusal.message}`
    case "CallFailed":
      return `The call failed: ${refusal.message}`
    case "HostCommandFailed":
      return `The tray app could not do that: ${refusal.message}`
  }
}
