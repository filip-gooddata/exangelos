import * as Path from "node:path"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Refused } from "./Entries.ts"

const isLocal = (url: string) => Path.isAbsolute(url) || url.startsWith("file://")

const checkUrl = (url: string) => {
  if (isLocal(url)) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Refused({ reason: `${url} is not a URL` })
  }
  if (parsed.protocol !== "https:") throw new Refused({ reason: "only https git repositories are accepted" })
}

const checkRef = (ref: string) => {
  const valid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock")
  if (!valid) throw new Refused({ reason: `${ref} is not a branch, tag or commit name` })
}

/**
 * The git arguments for each step of a checkout, in order. Hooks, filesystem monitors, credential
 * helpers and every transport but https (and file for a local path) are off.
 */
export const commands = (url: string, ref: string, work: string): ReadonlyArray<ReadonlyArray<string>> => {
  const config = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null",
    "-c", "credential.helper=",
    "-c", "submodule.recurse=false",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    ...(isLocal(url) ? ["-c", "protocol.file.allow=always"] : [])
  ]
  return [
    [...config, "init", "--quiet", "--template=", work],
    [...config, "-C", work, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", url, ref],
    [...config, "-C", work, "checkout", "--quiet", "--detach", "FETCH_HEAD"]
  ]
}

/**
 * Checks out the ref of the repository into `work` with git, without the owner's configuration,
 * and with `home` as the home directory. The caller removes `.git`.
 */
export const checkout = (url: string, ref: string, work: string, home: string) =>
  Effect.gen(function*() {
    yield* Effect.try({
      try: () => {
        checkUrl(url)
        checkRef(ref)
      },
      catch: (error) => error as Refused
    })
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const env = {
      PATH: process.env["PATH"],
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      LC_ALL: "C"
    }
    for (const args of commands(url, ref, work)) {
      const step = args[args.indexOf("--quiet") - 1]
      const code = yield* spawner.exitCode(ChildProcess.make("git", [...args], { env })).pipe(
        Effect.mapError((error) => new Refused({ reason: `git ${step} failed: ${error.message}` }))
      )
      if (code !== 0) return yield* new Refused({ reason: `git ${step} exited with code ${code}` })
    }
  })
