import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { DaemonContract } from "@exangelos/contracts"
import { Ids } from "@exangelos/domain"
import { callOf, run, subscription } from "./harness.ts"

describe("agent commands", () => {
  it("subscribes with the main parameter, key=value pairs and the intent", async () => {
    const result = await run(
      ["subscribe", "github-pr", "acme/app#123", "branch=main", "depth=2", "--intent", "fix CI on PR 123", "--once"]
    )
    expect(result.exit._tag).toBe("Success")
    const call = callOf(result, "Subscribe")
    expect(call?.payload).toMatchObject({
      plugin: "github-pr",
      main: "acme/app#123",
      parameters: { branch: "main", depth: "2" },
      intent: "fix CI on PR 123",
      maxEvents: 1,
      target: { _tag: "Caller" },
      similarOk: []
    })
    expect(result.stdout).toContain("Subscription:  sub_7f3k")
  })

  it("refuses a malformed parameter before calling the daemon", async () => {
    const result = await run(["subscribe", "github-pr", "acme/app#123", "branch", "--intent", "x"])
    expect(result.exit._tag).toBe("Failure")
    expect(result.stderr).toContain("\"branch\" is not a key=value pair")
    expect(result.calls).toEqual([])
  })

  it("shows similar subscriptions, and the resubmit with --similar-ok creates the subscription", async () => {
    const similar = subscription({ id: Ids.SubscriptionId.make("sub_old1"), parameters: { pr: "acme/app#123" } })
    const refuse = (payload: { readonly similarOk: ReadonlyArray<string> }) =>
      payload.similarOk.includes("sub_old1")
        ? Effect.succeed(subscription())
        : Effect.fail(new DaemonContract.SimilarSubscriptions({ similar: [similar] }))
    const argv = ["subscribe", "github-pr", "acme/app#123", "--intent", "fix CI"]

    const refused = await run(argv, { handlers: { Subscribe: refuse } })
    expect(refused.exit._tag).toBe("Failure")
    expect(refused.stderr).toBe(
      [
        "Nothing was created: this session already has a similar open subscription.",
        "  sub_old1  parameters: pr=acme/app#123",
        "If you still want a separate subscription, run the same command again with --similar-ok sub_old1."
      ].join("\n")
    )

    const created = await run([...argv, "--similar-ok", "sub_old1"], { handlers: { Subscribe: refuse } })
    expect(created.exit._tag).toBe("Success")
    expect(callOf(created, "Subscribe")?.payload).toMatchObject({ similarOk: ["sub_old1"] })
  })

  it.each([
    { argv: ["list", "--all"], rpc: "List", payload: { all: true }, out: "sub_7f3k  github-pr  acme/app#123  active" },
    { argv: ["show", "sub_7f3k"], rpc: "Show", payload: { id: "sub_7f3k" }, out: "Intent:        fix CI on PR 123" },
    { argv: ["events", "sub_7f3k"], rpc: "Events", payload: { id: "sub_7f3k" }, out: "No stored events." },
    {
      argv: ["ack", "sub_7f3k", "--through", "5"],
      rpc: "Ack",
      payload: { id: "sub_7f3k", through: 5 },
      out: "Acknowledged sub_7f3k through #5."
    },
    { argv: ["wait", "sub_7f3k"], rpc: "Wait", payload: { id: "sub_7f3k" }, out: "exangelos ack sub_7f3k --through 4" },
    { argv: ["pause", "sub_7f3k"], rpc: "Pause", payload: { id: "sub_7f3k" }, out: "sub_7f3k is paused by you." },
    { argv: ["resume", "sub_7f3k"], rpc: "Resume", payload: { id: "sub_7f3k" }, out: "sub_7f3k is active." },
    {
      argv: ["retarget", "sub_7f3k", "--target", "codex:abc"],
      rpc: "Retarget",
      payload: { id: "sub_7f3k", target: { _tag: "Session", session: { harness: "codex", sessionId: "abc" } } },
      out: "sub_7f3k now wakes t3:thread-1."
    },
    { argv: ["cancel", "sub_7f3k"], rpc: "Cancel", payload: { id: "sub_7f3k" }, out: "sub_7f3k is cancelled by you." }
  ])("$rpc sends its payload and prints the answer", async ({ argv, out, payload, rpc }) => {
    const result = await run(argv)
    expect(result.exit._tag).toBe("Success")
    expect(callOf(result, rpc)?.payload).toEqual(payload)
    expect(result.stdout).toContain(out)
  })

  it("tells a Claude Code session how to wait, and a T3 session nothing", async () => {
    const claude = subscription({ wakeTarget: { harness: "claude-code", sessionId: "c-1" } })
    const hint =
      "Claude Code sessions don't receive wakes yet: run `exangelos wait sub_7f3k` as a background command; it returns when there is something to say."
    const subscribed = await run(["subscribe", "github-pr", "acme/app#123", "--intent", "x"], {
      handlers: { Subscribe: () => Effect.succeed(claude) }
    })
    expect(subscribed.stdout.split("\n").at(-1)).toBe(hint)
    const resumed = await run(["resume", "sub_7f3k", "--json"], { handlers: { Resume: () => Effect.succeed(claude) } })
    expect(JSON.parse(resumed.stdout)).toMatchObject({ id: "sub_7f3k", hint })
    const t3 = await run(["subscribe", "github-pr", "acme/app#123", "--intent", "x"])
    expect(t3.stdout).not.toContain("Claude Code")
  })

  it("prints one JSON document with --json, for an answer and for a refusal", async () => {
    const listed = await run(["list", "--json"])
    const [first] = JSON.parse(listed.stdout)
    expect(first).toMatchObject({ id: "sub_7f3k", createdAt: "2026-11-12T10:00:00.000Z", state: { _tag: "Active" } })

    const waited = await run(["--json", "wait", "sub_7f3k"])
    expect(JSON.parse(waited.stdout)).toMatchObject({
      text: expect.stringContaining("1 event on sub_7f3k"),
      wake: { subscription: "sub_7f3k", pending: [{ number: 4 }] }
    })

    const missing = await run(["show", "sub_none", "--json"], {
      handlers: { Show: () => Effect.fail(new DaemonContract.SubscriptionNotFound({ id: "sub_none" })) }
    })
    expect(missing.exit._tag).toBe("Failure")
    expect(missing.stderr).toBe("")
    expect(JSON.parse(missing.stdout)).toEqual({
      error: {
        _tag: "SubscriptionNotFound",
        id: "sub_none",
        message: "No subscription sub_none. Run `exangelos list --all` to see every subscription."
      }
    })
  })
})
