import { Config, Console, Effect, FileSystem, Path } from "effect"
import { Command, Flag } from "effect/cli"
import { WakeText } from "@exangelos/contracts"
import * as Build from "../Build.ts"
import { CommandFailed, Json } from "./Output.ts"

const marker = "<!-- Installed by `exangelos skill install`"

const skillText = Effect.gen(function*() {
  if (Build.skill !== undefined) return Build.skill
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.join(import.meta.dirname, "../../../../skills/exangelos/SKILL.md"))
})

const installedText = (text: string) =>
  `${text.trimEnd()}\n\n${marker} ${Build.version}. Rerun it after upgrading Exangelos; edits here are overwritten. -->\n`

const hosts = [
  { name: "claude", label: "Claude Code", directory: [".claude", "skills", "exangelos"] },
  { name: "codex", label: "Codex", directory: [".agents", "skills", "exangelos"] }
] as const

type Host = typeof hosts[number]

const chosen = (options: { readonly claude: boolean; readonly codex: boolean }): ReadonlyArray<Host> =>
  !options.claude && !options.codex ? hosts : hosts.filter((host) => options[host.name])

const hostFlags = {
  claude: Flag.Boolean("claude").pipe(Flag.withDefault(false), Flag.withDescription("Only Claude Code")),
  codex: Flag.Boolean("codex").pipe(Flag.withDefault(false), Flag.withDescription("Only Codex"))
}

interface Outcome {
  readonly host: Host["name"]
  readonly path: string
  readonly status: "installed" | "updated" | "unchanged" | "removed" | "absent" | "foreign"
}

const locate = (host: Host) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(yield* Config.NonEmptyString("HOME"), ...host.directory)
    const file = path.join(directory, "SKILL.md")
    const linked = yield* fs.readLink(directory).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
    const current = linked || !(yield* fs.exists(file)) ? undefined : yield* fs.readFileString(file)
    const exists = linked || (yield* fs.exists(directory))
    const ours = current !== undefined && current.includes(marker)
    return { directory, file, linked, current, exists, ours }
  })

const report = (outcomes: ReadonlyArray<Outcome>, sentence: (outcome: Outcome) => string) =>
  Effect.gen(function*() {
    if (yield* Json) yield* Console.log(JSON.stringify(outcomes))
    else for (const outcome of outcomes) yield* Console.log(sentence(outcome))
    if (outcomes.some((outcome) => outcome.status === "foreign")) {
      return yield* new CommandFailed({ tag: "SkillForeign" })
    }
  })

const labelOf = (name: Host["name"]) => hosts.find((host) => host.name === name)!.label

const failed = (error: { readonly message: string }) =>
  Effect.gen(function*() {
    const message = `Writing the skill failed: ${error.message}`
    yield* (yield* Json) ? Console.log(JSON.stringify({ error: { _tag: "SkillFailed", message } })) : Console.error(message)
    return yield* new CommandFailed({ tag: "SkillFailed" })
  })

const install = Command.make(
  "install",
  {
    ...hostFlags,
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Replace an exangelos skill that this command did not install")
    )
  },
  (options) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const text = installedText(yield* skillText)
      const outcomes: Array<Outcome> = []
      for (const host of chosen(options)) {
        const found = yield* locate(host)
        const foreign = found.linked || (found.current !== undefined && !found.ours)
        if (foreign && !options.force) {
          outcomes.push({ host: host.name, path: found.directory, status: "foreign" })
          continue
        }
        if (found.current === text) {
          outcomes.push({ host: host.name, path: found.file, status: "unchanged" })
          continue
        }
        if (found.linked) yield* fs.remove(found.directory)
        yield* fs.makeDirectory(found.directory, { recursive: true })
        yield* fs.writeFileString(found.file, text)
        outcomes.push({ host: host.name, path: found.file, status: found.current === undefined ? "installed" : "updated" })
      }
      yield* report(outcomes, ({ host, path, status }) =>
        status === "foreign"
          ? `${labelOf(host)}: left ${path} alone; it holds an exangelos skill this command did not install. Pass --force to replace it.`
          : `${labelOf(host)}: ${status} ${path}`)
    }).pipe(Effect.catchTag(["PlatformError", "ConfigError"], failed))
).pipe(Command.withDescription(`Install the ${WakeText.command} agent skill for Claude Code and Codex, or update it after an upgrade`))

const uninstall = Command.make(
  "uninstall",
  hostFlags,
  (options) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const outcomes: Array<Outcome> = []
      for (const host of chosen(options)) {
        const found = yield* locate(host)
        if (!found.ours) {
          outcomes.push({ host: host.name, path: found.directory, status: found.exists ? "foreign" : "absent" })
          continue
        }
        yield* fs.remove(found.file)
        if ((yield* fs.readDirectory(found.directory)).length === 0) yield* fs.remove(found.directory, { recursive: true })
        outcomes.push({ host: host.name, path: found.directory, status: "removed" })
      }
      yield* report(outcomes, ({ host, path, status }) =>
        status === "foreign"
          ? `${labelOf(host)}: left ${path} alone; this command did not install it.`
          : status === "absent"
          ? `${labelOf(host)}: not installed.`
          : `${labelOf(host)}: removed ${path}`)
    }).pipe(Effect.catchTag(["PlatformError", "ConfigError"], failed))
).pipe(Command.withDescription("Remove the agent skill that `skill install` wrote"))

const show = Command.make("show", {}, () => Effect.flatMap(skillText, Console.log)).pipe(
  Command.withDescription("Print the agent skill, for a harness that installs skills another way")
)

export const command = Command.make("skill").pipe(
  Command.withDescription("Install the agent skill that teaches Claude Code and Codex to use Exangelos"),
  Command.withSubcommands([install, uninstall, show])
)
