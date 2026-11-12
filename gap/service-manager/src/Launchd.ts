import { Effect, FileSystem, Layer, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { makeRunner, makeUserService, type ServiceDefinition, ServiceStatus, UserService } from "./UserService.ts"

const notFoundByPrint = 113
const notFoundByBootout = 3

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")

const string = (text: string) => `<string>${escapeXml(text)}</string>`
const key = (text: string) => `<key>${escapeXml(text)}</key>`

export const renderPlist = (definition: ServiceDefinition): string => {
  const environment = Object.entries(definition.environment)
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  ${key("Label")}`,
    `  ${string(definition.label)}`,
    `  ${key("ProgramArguments")}`,
    `  <array>`,
    ...[definition.program, ...definition.arguments].map((word) => `    ${string(word)}`),
    `  </array>`,
    ...(environment.length === 0 ? [] : [
      `  ${key("EnvironmentVariables")}`,
      `  <dict>`,
      ...environment.flatMap(([name, value]) => [`    ${key(name)}`, `    ${string(value)}`]),
      `  </dict>`
    ]),
    `  ${key("RunAtLoad")}`,
    `  <true/>`,
    `  ${key("KeepAlive")}`,
    `  <dict>`,
    `    ${key("SuccessfulExit")}`,
    `    <false/>`,
    `  </dict>`,
    `  ${key("StandardOutPath")}`,
    `  ${string(definition.stdoutPath)}`,
    `  ${key("StandardErrorPath")}`,
    `  ${string(definition.stderrPath)}`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n")
}

export const layerLaunchd = (options: {
  readonly directory: string
  readonly uid: number
}): Layer.Layer<
  UserService,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Layer.effect(
    UserService,
    Effect.gen(function*() {
      const run = yield* makeRunner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const domain = `gui/${options.uid}`
      const target = (label: string) => `${domain}/${label}`
      const plist = (label: string) => path.join(options.directory, `${label}.plist`)

      const loaded = (label: string) =>
        Effect.map(
          run.succeed("launchctl", ["print", target(label)], [notFoundByPrint]),
          (output) => output.exitCode === 0 ? output.stdout : undefined
        )

      const bootout = (label: string) => run.succeed("launchctl", ["bootout", target(label)], [notFoundByBootout])

      return makeUserService({
        install: (definition) =>
          Effect.gen(function*() {
            yield* fs.makeDirectory(options.directory, { recursive: true })
            yield* fs.writeFileString(plist(definition.label), renderPlist(definition))
          }),
        start: (label) =>
          Effect.gen(function*() {
            const printed = yield* loaded(label)
            yield* printed === undefined
              ? run.succeed("launchctl", ["bootstrap", domain, plist(label)])
              : run.succeed("launchctl", ["kickstart", target(label)])
          }),
        stop: (label) => Effect.asVoid(bootout(label)),
        uninstall: (label) =>
          Effect.gen(function*() {
            yield* bootout(label)
            yield* fs.remove(plist(label), { force: true })
          }),
        status: (label) =>
          Effect.gen(function*() {
            const printed = yield* loaded(label)
            if (printed === undefined) {
              return (yield* fs.exists(plist(label))) ? ServiceStatus.Stopped() : ServiceStatus.NotInstalled()
            }
            if (/^\tstate = running$/m.exec(printed) === null) {
              return ServiceStatus.Stopped()
            }
            const pid = /^\tpid = (\d+)$/m.exec(printed)?.[1]
            return ServiceStatus.Running(pid === undefined ? {} : { pid: Number(pid) })
          })
      })
    })
  )
