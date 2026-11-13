import type { DaemonContract } from "@exangelos/contracts"
import type { Alert, Catalogue, Event, Plugin, Session, Subscription, Wake } from "@exangelos/domain"
import { DateTime, Duration } from "effect"
import type { Detail, ServiceStatus } from "../daemon/DaemonClient.ts"
import type { Refusal } from "../state/Panel.ts"

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const millis = (at: DateTime.Utc) => DateTime.toEpochMillis(at)

export const harnessName: Record<Session.Harness, string> = { t3: "T3 Code", "claude-code": "Claude Code", codex: "Codex" }

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

export const actorName = (actor: Session.Actor): string =>
  actor._tag === "You" ? "you" : `${harnessName[actor.session.harness]} session ${actor.session.sessionId}`

export const pending = (subscription: Subscription.Subscription): number =>
  subscription.lastNumber - subscription.ackedThrough

export const isOpen = (subscription: Subscription.Subscription): boolean =>
  subscription.state._tag === "Active" || subscription.state._tag === "Paused" || subscription.state._tag === "Expired"

/** The plugin an active subscription waits on while that plugin is unavailable. */
export const suspendedOn = (
  subscription: Subscription.Subscription,
  plugins: ReadonlyArray<Plugin.Plugin>
): Plugin.Plugin | undefined =>
  subscription.state._tag === "Active"
    ? plugins.find((plugin) => plugin.name === subscription.plugin && plugin.unavailableSince !== undefined)
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

const pauseReason = (reason: Subscription.PauseReason, subscription: Subscription.Subscription): string => {
  switch (reason._tag) {
    case "BacklogCount":
      return `the backlog reached ${reason.limit} pending events`
    case "BacklogAge":
      return `its oldest pending event passed ${span(Duration.toMillis(reason.limit))}`
    case "Actor":
      return `${actorName(reason.actor)} paused it with ${pending(subscription)} pending`
  }
}

/** The state fact on a row's third line. */
export const stateFact = (now: number, subscription: Subscription.Subscription, suspended?: Plugin.Plugin): string => {
  const { state, stateSince } = subscription
  switch (state._tag) {
    case "Active":
      return suspended?.unavailableSince !== undefined
        ? `Suspended ${ago(now, suspended.unavailableSince)}, ${suspended.name} is unavailable`
        : `Expires ${until(now, subscription.expiresAt)}`
    case "Paused":
      return state.reason._tag === "Actor"
        ? `Paused by ${actorName(state.reason.actor)} ${ago(now, stateSince)}`
        : `Paused ${ago(now, stateSince)}: ${pauseReason(state.reason, subscription)}`
    case "Expired":
      return `Expired ${ago(now, stateSince)}`
    case "Ended":
      return state.reason._tag === "MaxEvents"
        ? `Ended ${ago(now, stateSince)} after its last allowed event`
        : `Ended ${ago(now, stateSince)} by the plugin: ${state.reason.reason}`
    case "Cancelled":
      return `Cancelled ${ago(now, stateSince)} by ${actorName(state.actor)}`
  }
}

/** The state in whole sentences, for the top of one subscription. */
export const stateSentence = (now: number, subscription: Subscription.Subscription, suspended?: Plugin.Plugin): string => {
  const { state, stateSince } = subscription
  const expires = `Expires ${until(now, subscription.expiresAt)}.`
  switch (state._tag) {
    case "Active":
      return suspended === undefined
        ? `Active. ${expires}`
        : `Active and suspended: ${suspended.name} is unavailable${
          suspended.unavailableSince === undefined ? "" : ` since ${ago(now, suspended.unavailableSince)}`
        }. It continues by itself when the plugin returns. ${expires}`
    case "Paused":
      return `Paused ${ago(now, stateSince)}: ${pauseReason(state.reason, subscription)}. Nothing is watched while paused. ${expires}`
    case "Expired":
      return `Expired ${ago(now, stateSince)}. Nothing is watched until someone resumes it.`
    case "Ended":
    case "Cancelled":
      return `${stateFact(now, subscription)}.`
  }
}

const wakeReasons: Record<Wake.WakeReason, string> = {
  events: "events",
  paused: "paused itself",
  expired: "expired",
  suspended: "suspended",
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

const changeTitles: Readonly<Record<string, string>> = {
  create: "Created",
  update: "Updated",
  ack: "Acknowledged",
  pause: "Paused",
  resume: "Resumed",
  retarget: "Retargeted",
  cancel: "Cancelled"
}

/** One change as a history line. A kind without a title of its own reads as its name, so a new kind still shows. */
export const changeTitle = (change: Subscription.Change): string => {
  const kind: string = change.kind
  if (kind === "eventAlerts") return `Event alerts turned ${change.detail === "off" ? "off" : "on"}`
  const title = changeTitles[kind] ?? capitalized(kind)
  return change.detail === undefined ? title : `${title}: ${change.detail}`
}

export interface HistoryEntry {
  readonly title: string
  readonly by: string
  readonly at: DateTime.Utc
}

/** Changes and wakes, newest first. A stop the daemon made itself has no change, so its wake carries it. */
export const history = (detail: Detail): ReadonlyArray<HistoryEntry> =>
  [
    ...detail.changes.map((change): HistoryEntry => ({
      title: changeTitle(change),
      by: `By ${actorName(change.actor)}`,
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

export const pluginInitials = (name: string): string => {
  const parts = name.split(/[^a-z0-9]+/i).filter((part) => part.length > 0)
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2)
  return letters.toUpperCase()
}

export const originSummary = (origin: Plugin.Origin): string => {
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
export const originRows = (origin: Plugin.Origin): ReadonlyArray<readonly [string, string]> => {
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

export const trustText = (trust: Plugin.Trust): string => capitalized(trust)

export const processText = (process: Plugin.ProcessState): string => capitalized(process)

export const configurationFields = (plugin: Plugin.Plugin): ReadonlyArray<Catalogue.ConfigurationField> =>
  plugin.catalogue?.configuration ?? []

export const configurationText = (plugin: Plugin.Plugin): string => {
  if (configurationFields(plugin).length === 0 && plugin.configuration._tag !== "Rejected") return "None needed"
  switch (plugin.configuration._tag) {
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

/** Whether a secret is stored. The plugin record says only whether the configuration as a whole is set. */
export const secretStored = (plugin: Plugin.Plugin): boolean => plugin.configuration._tag !== "Missing"

/** The sessions that wake targets name, each once, in the order the subscriptions list them. */
export const knownSessions = (subscriptions: ReadonlyArray<Subscription.Subscription>): ReadonlyArray<Session.Session> =>
  subscriptions.reduce<ReadonlyArray<Session.Session>>((sessions, subscription) => {
    const target = subscription.wakeTarget
    return target === undefined || sessions.some((s) => s.harness === target.harness && s.sessionId === target.sessionId)
      ? sessions
      : [...sessions, target]
  }, [])

/** The number "Acknowledge through" uses: the event you picked while it is still pending, else the newest pending one. */
export const ackThroughNumber = (subscription: Subscription.Subscription, chosen: number | null): number | undefined => {
  if (subscription.lastNumber <= subscription.ackedThrough) return undefined
  return chosen !== null && chosen > subscription.ackedThrough && chosen <= subscription.lastNumber
    ? chosen
    : subscription.lastNumber
}

/** A digest cut to its head and tail, for rows: "sha256 9c1f04ab…e27a". */
export const shortDigest = (digest: string): string => {
  const hex = digest.replace(/^sha256[:-]?/, "")
  return hex.length <= 14 ? `sha256 ${hex}` : `sha256 ${hex.slice(0, 8)}…${hex.slice(-4)}`
}

/** The import you typed, or nothing while a field it needs is empty. */
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

/** The configuration values to send: only the fields you filled in. */
export const filledValues = (
  fields: ReadonlyArray<Catalogue.ConfigurationField>,
  edits: Readonly<Record<string, string>>
): Catalogue.ConfigurationValues =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = edits[field.key]
      return value === undefined || value.trim() === "" ? [] : [[field.key, isSecretField(field) ? value : value.trim()] as const]
    })
  )

export const startMethodText: Record<ServiceStatus["startMethod"], string> = {
  homebrew: "Started by its Homebrew service",
  "launch-agent": "Started at login by launchd",
  "systemd-user": "Started by its systemd user service",
  foreground: "Started in a terminal, in the foreground"
}

export interface NeedsYouItem {
  readonly plugin: string
  readonly title: string
  readonly detail: string
  readonly action: string
}

const suspendedCount = (plugin: string, subscriptions: ReadonlyArray<Subscription.Subscription>) => {
  const count = subscriptions.filter((s) => s.plugin === plugin && s.state._tag === "Active").length
  return count === 0 ? "" : count === 1 ? " One subscription is suspended." : ` ${count} subscriptions are suspended.`
}

export const needsYouItem = (
  now: number,
  alert: Alert.Alert,
  plugins: ReadonlyArray<Plugin.Plugin>,
  subscriptions: ReadonlyArray<Subscription.Subscription>
): NeedsYouItem => {
  const plugin = plugins.find((p) => p.name === alert.plugin)
  const since = plugin?.unavailableSince === undefined ? "" : ` ${capitalized(ago(now, plugin.unavailableSince))}.`
  switch (alert._tag) {
    case "CredentialsRejected":
      return {
        plugin: alert.plugin,
        title: `The source rejected the ${alert.plugin} credentials.`,
        detail: `${alert.reason}.${since}${suspendedCount(alert.plugin, subscriptions)}`.replace(/\.\./g, "."),
        action: "Enter credentials"
      }
    case "WaitsForEnable":
      return {
        plugin: alert.plugin,
        title: `${alert.plugin} waits to be enabled.`,
        detail: `${plugin === undefined ? "Imported" : originSummary(plugin.origin)}. Inert until you enable it.`,
        action: "Enable"
      }
    case "Failing":
      return {
        plugin: alert.plugin,
        title: `${alert.plugin} keeps failing.`,
        detail: `${alert.reason}.${since}${suspendedCount(alert.plugin, subscriptions)}`.replace(/\.\./g, "."),
        action: "Open"
      }
    case "DigestMismatch":
      return {
        plugin: alert.plugin,
        title: `${alert.plugin} does not match its official checksum.`,
        detail: "It stays inert. Remove it, and the daemon fetches it again when an agent needs it.",
        action: "Review"
      }
    case "Event":
      return { plugin: alert.plugin, title: `${alert.subject}: ${alert.event}`, detail: alert.subscription, action: "Open" }
  }
}

/** The sentence that tells you why the daemon or the tray app refused an action. */
export const refusalText = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case "BacklogOverLimit":
      return `The backlog holds ${refusal.pending} pending events, over the limit of ${refusal.limit}. Acknowledge events, then resume.`
    case "TransitionRefused":
    case "InvalidRequest":
    case "NoWakeTarget":
      return refusal.message
    case "SubscriptionNotFound":
      return `The daemon has no subscription ${refusal.id}.`
    case "ImportFailed":
      return `The import failed: ${refusal.reason}`
    case "PluginNotFound":
      return `The daemon has no plugin ${refusal.plugin}.`
    case "PluginUnavailable":
      return `${refusal.plugin} is unavailable: ${refusal.problem}`
    case "DigestMismatch":
      return `${refusal.plugin} changed after you read its checksum, so it stays inert. Read the new checksum before you enable it.`
    case "ConfigurationInvalid":
      return `The configuration is not valid: ${refusal.reason}`
    case "ConfigurationRejected":
      return `The source rejected this configuration: ${refusal.reason}`
    case "DaemonNotRunning":
      return `The daemon is not running: ${refusal.message}`
    case "CallFailed":
      return `The call failed: ${refusal.message}`
    case "HostCommandFailed":
      return `The tray app could not do that: ${refusal.message}`
  }
}
