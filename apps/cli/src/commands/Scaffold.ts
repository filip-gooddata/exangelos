import { Console, Effect, FileSystem, Path } from "effect"
import { Argument, Command } from "effect/cli"
import { WakeText } from "@exangelos/contracts"
import * as Build from "../Build.ts"
import { CommandFailed, Json } from "./Output.ts"

const skipped = new Set(["node_modules", ".turbo", "dist"])

const templateFiles = Effect.gen(function*() {
  if (Build.connectorTemplate !== undefined) return Build.connectorTemplate
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(import.meta.dirname, "../../../../connectors/template")
  const files: Record<string, string> = {}
  for (const entry of yield* fs.readDirectory(directory, { recursive: true })) {
    if (entry.split(path.sep).some((segment) => skipped.has(segment))) continue
    const file = path.join(directory, entry)
    if ((yield* fs.stat(file)).type === "File") files[entry] = yield* fs.readFileString(file)
  }
  return files
})

const identifier = (name: string): string =>
  name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("")

const placeholders = /@exangelos\/connector-template|Template|template/g

const rename = (name: string) => (placeholder: string): string =>
  placeholder === "Template" ? identifier(name) : placeholder === "template" ? name : `@exangelos/connector-${name}`

export const renamed = (
  files: Readonly<Record<string, string>>,
  name: string
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(files).map(([file, text]) => [file.replace(placeholders, rename(name)), text.replace(placeholders, rename(name))])
  )

const readme = (name: string): string =>
  `# ${name}\n\nAn Exangelos connector. In v1 it builds only inside the Exangelos monorepo, so keep this directory under \`connectors/\` there.\n`

const refuse = (tag: string, message: string) =>
  Effect.gen(function*() {
    yield* (yield* Json) ? Console.log(JSON.stringify({ error: { _tag: tag, message } })) : Console.error(message)
    return yield* new CommandFailed({ tag })
  })

export const command = Command.make(
  "scaffold",
  { name: Argument.String("name").pipe(Argument.withDescription("The new connector's name, such as github-pr")) },
  ({ name }) =>
    Effect.gen(function*() {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
        return yield* refuse(
          "InputInvalid",
          `${name} is not a connector name: use lowercase letters, digits and single hyphens, starting with a letter.`
        )
      }
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.resolve(name)
      if (yield* fs.exists(directory)) {
        return yield* refuse("DirectoryExists", `Nothing was written: ${directory} already exists.`)
      }
      const files = { ...renamed(yield* templateFiles, name), "README.md": readme(name) }
      for (const [file, text] of Object.entries(files)) {
        const target = path.join(directory, file)
        yield* fs.makeDirectory(path.dirname(target), { recursive: true })
        yield* fs.writeFileString(target, text)
      }
      yield* (yield* Json)
        ? Console.log(JSON.stringify({ directory, files: Object.keys(files).sort() }))
        : Console.log(
          `Wrote the ${name} connector to ${directory}. Build it with \`bun run build\` there, then load it with \`${WakeText.command} connector dev-link ${directory}\`.`
        )
    }).pipe(
      Effect.catchTag("PlatformError", (error) => refuse("ScaffoldFailed", `Writing the connector failed: ${error.message}`))
    )
).pipe(Command.withDescription("Write a renamed copy of the connector template into a new directory"))
