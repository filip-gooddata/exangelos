import { Option } from "effect"
import { Session } from "@exangelos/domain"

export const harnessHeader = "x-exangelos-harness"
export const sessionHeader = "x-exangelos-session-id"

export const toHeaders = (session: Session.Session): Record<string, string> => ({
  [harnessHeader]: session.harness,
  [sessionHeader]: session.sessionId
})

const isHarness = (value: string | undefined): value is Session.Harness =>
  value === "t3" || value === "claude-code" || value === "codex"

export const fromHeaders = (
  headers: Readonly<Record<string, string | undefined>>
): Option.Option<Session.Session> => {
  const harness = headers[harnessHeader]
  const sessionId = headers[sessionHeader]
  return isHarness(harness) && sessionId !== undefined && sessionId.length > 0
    ? Option.some({ harness, sessionId })
    : Option.none()
}

export const actorFromHeaders = (headers: Readonly<Record<string, string | undefined>>): Session.Actor =>
  Option.match(fromHeaders(headers), {
    onNone: () => Session.Actor.cases.You.make({}),
    onSome: (session) => Session.Actor.cases.Session.make({ session })
  })

const detectionOrder: ReadonlyArray<readonly [string, Session.Harness]> = [
  ["T3CODE_THREAD_ID", "t3"],
  ["CLAUDE_CODE_SESSION_ID", "claude-code"],
  ["CODEX_THREAD_ID", "codex"]
]

export const detect = (env: Readonly<Record<string, string | undefined>>): Option.Option<Session.Session> => {
  for (const [variable, harness] of detectionOrder) {
    const sessionId = env[variable]
    if (sessionId !== undefined && sessionId.length > 0) return Option.some({ harness, sessionId })
  }
  return Option.none()
}
