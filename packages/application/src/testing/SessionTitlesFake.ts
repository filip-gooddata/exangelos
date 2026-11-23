import { Effect, Layer } from "effect"
import type { Session } from "@exangelos/domain"
import { SessionTitles } from "../ports/SessionTitles.ts"

/** Names the sessions it is given titles for and leaves the rest out. */
export const layerSessionTitlesFrom = (known: ReadonlyArray<Session.SessionTitle>): Layer.Layer<SessionTitles> =>
  Layer.succeed(SessionTitles, {
    titles: (sessions) =>
      Effect.succeed(known.filter((title) =>
        sessions.some((session) => session.harness === title.harness && session.sessionId === title.sessionId)
      ))
  })

export const layerSessionTitles: Layer.Layer<SessionTitles> = layerSessionTitlesFrom([])
