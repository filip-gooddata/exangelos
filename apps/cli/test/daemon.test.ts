/// <reference types="bun" />
import { mkdtempSync, rmSync } from "node:fs"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { callOf, run } from "./harness.ts"

const directory = mkdtempSync("/tmp/xng-cli-")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe("the daemon socket", () => {
  it("carries the session detected from the environment to the daemon", async () => {
    const result = await run(["subscribe", "github-pr", "acme/app#123", "--intent", "fix CI"], {
      socket: { path: `${directory}/daemon.sock`, env: { T3CODE_THREAD_ID: "thread-1" } }
    })
    expect(result.exit._tag).toBe("Success")
    expect(callOf(result, "Subscribe")?.headers).toMatchObject({
      "x-exangelos-harness": "t3",
      "x-exangelos-session-id": "thread-1"
    })
  })

  it("prints the no-daemon text and fails when nothing answers", async () => {
    const path = `${directory}/missing.sock`
    const result = await run(["list"], { socket: { path, serve: false } })
    expect(result.exit._tag).toBe("Failure")
    expect(result.stderr).toBe(
      `No Exangelos daemon is running, and starting it failed: nothing answers on ${path}. Run \`exangelos daemon\` in a terminal to start it in the foreground, then retry this command.`
    )
    expect(result.calls).toEqual([])
  })
})
