import { Context } from "effect"
import type { Effect } from "effect"
import type { Session } from "@exangelos/domain"

export class SessionTitles extends Context.Service<SessionTitles, {
  /** The title of each session its harness has named, answered at once. A session without one yet is left out. */
  readonly titles: (sessions: ReadonlyArray<Session.Target>) => Effect.Effect<ReadonlyArray<Session.SessionTitle>>
}>()("@exangelos/application/SessionTitles") {}
