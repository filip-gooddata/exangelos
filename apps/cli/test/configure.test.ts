/// <reference types="bun" />
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { DaemonContract } from "@exangelos/contracts"
import { callOf, run } from "./harness.ts"

const directory = mkdtempSync(join(tmpdir(), "exangelos-cli-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const fake = "fake-value-7Q2"

describe("plugin configure", () => {
  it("reads a secret from a command and sends it only in ConfigurePlugin values", async () => {
    const result = await run(
      ["plugin", "configure", "github-pr", "host=github.example", "--secret-command", "token=pass show github"],
      { commandOutput: `${fake}\n` }
    )
    expect(result.exit._tag).toBe("Success")
    expect(result.ran).toEqual(["sh -c pass show github"])
    expect(callOf(result, "ConfigurePlugin")?.payload).toEqual({
      name: "github-pr",
      values: { host: "github.example", token: fake }
    })
    const elsewhere = result.calls.filter((call) => call.rpc !== "ConfigurePlugin")
    expect(JSON.stringify([result.stdout, result.stderr, elsewhere])).not.toContain(fake)
    expect(result.stdout).toBe("github-pr is configured.")
  })

  it("reads a secret from a file", async () => {
    const file = join(directory, "token")
    writeFileSync(file, `${fake}\n`)
    const result = await run(["plugin", "configure", "github-pr", "--secret-file", `token=${file}`])
    expect(result.exit._tag).toBe("Success")
    expect(callOf(result, "ConfigurePlugin")?.payload).toEqual({ name: "github-pr", values: { token: fake } })
  })

  it("keeps a secret the plugin echoes in its rejection out of the output", async () => {
    const file = join(directory, "rejected")
    writeFileSync(file, fake)
    const result = await run(["plugin", "configure", "github-pr", "--secret-file", `token=${file}`, "--json"], {
      handlers: {
        ConfigurePlugin: () => Effect.fail(new DaemonContract.ConfigurationRejected({ reason: `bad token ${fake}` }))
      }
    })
    expect(result.exit._tag).toBe("Failure")
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { _tag: "ConfigurationRejected", reason: "bad token [secret]" }
    })
    expect(result.stdout + result.stderr).not.toContain(fake)
  })

  it("keeps the failure readable when the secret matches part of its tag", async () => {
    const file = join(directory, "tag")
    writeFileSync(file, "Rejected")
    const handlers = {
      ConfigurePlugin: () => Effect.fail(new DaemonContract.ConfigurationRejected({ reason: "Rejected by GitHub" }))
    }
    const text = await run(["plugin", "configure", "github-pr", "--secret-file", `token=${file}`], { handlers })
    expect(text.exit._tag).toBe("Failure")
    expect(text.stderr).toContain("The plugin rejected the configuration: [secret] by GitHub.")
    const json = await run(["plugin", "configure", "github-pr", "--secret-file", `token=${file}`, "--json"], { handlers })
    expect(JSON.parse(json.stdout)).toMatchObject({ error: { _tag: "ConfigurationRejected", reason: "[secret] by GitHub" } })
  })

  it("refuses a secret field given as key=value and sends nothing", async () => {
    const result = await run(["plugin", "configure", "github-pr", `token=${fake}`])
    expect(result.exit._tag).toBe("Failure")
    expect(result.stderr).toContain("token is a secret field")
    expect(result.stderr).not.toContain(fake)
    expect(callOf(result, "ConfigurePlugin")).toBeUndefined()
  })
})
