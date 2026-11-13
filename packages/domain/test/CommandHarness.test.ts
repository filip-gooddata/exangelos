import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { CommandHarness, Session } from "../src/index.ts"

const valid = Schema.is(CommandHarness.Command)

describe("harness command", () => {
  it("takes placeholders in arguments only", () => {
    expect(valid(["/opt/relay", "--to={session}", "{subscription}"])).toBe(true)
    expect(CommandHarness.problem(["{session}", "x"])).toBe("the program cannot hold a placeholder, found {session}")
    expect(CommandHarness.problem(["relay", "{sesion}"])).toBe("unknown placeholder {sesion}, use {session} or {subscription}")
    expect(CommandHarness.problem([])).toBe("the command needs a program")
    expect(valid(["relay", "{sesion}"])).toBe(false)
  })

  it("puts each value in once, without reading it again", () => {
    expect(CommandHarness.substitute(["relay", "{session}/{subscription}", "{other"], { session: "$& {subscription}", subscription: "sub_1" }))
      .toEqual(["relay", "$& {subscription}/sub_1", "{other"])
  })

  it("keeps harness names and session ids apart from shell syntax and options", () => {
    const named = Schema.is(Session.NamedSession)
    expect(named({ harness: "relay", sessionId: "thread:42@host" })).toBe(true)
    expect(named({ harness: "relay", sessionId: "; rm -rf ~" })).toBe(false)
    expect(named({ harness: "relay", sessionId: "-x" })).toBe(false)
    expect(named({ harness: "t3", sessionId: "x" })).toBe(false)
    expect(Schema.is(Session.Target)({ harness: "t3", sessionId: "-x:1" })).toBe(true)
  })
})
