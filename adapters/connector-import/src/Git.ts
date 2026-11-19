import * as Path from "node:path"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { limits, Refused } from "./Entries.ts"

const isLocal = (url: string) => Path.isAbsolute(url) || url.startsWith("file://")

const checkUrl = (url: string) => {
  if (Path.isAbsolute(url)) return
  if (url.startsWith("file://")) {
    const parsed = URL.canParse(url) ? new URL(url) : undefined
    if (parsed === undefined || (parsed.host !== "" && parsed.host !== "localhost") || parsed.search !== "" || parsed.hash !== "") {
      throw new Refused({ reason: `${url} is not a local repository path` })
    }
    return
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Refused({ reason: "the git repository address is not a URL" })
  }
  if (parsed.protocol !== "https:") throw new Refused({ reason: "only https git repositories are accepted" })
}

const checkRef = (ref: string) => {
  const valid = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock")
  if (!valid) throw new Refused({ reason: `${ref} is not a branch, tag or commit name` })
}

/**
 * The git arguments for each step of a checkout, in order: init, fetch, list the fetched tree and
 * check it out. Hooks, filesystem monitors, credential
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
    [...config, "-C", work, "ls-tree", "-r", "-l", "-z", "--full-tree", "FETCH_HEAD"],
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
    const [init, fetch, list, check] = commands(url, ref, work)
    const run = (step: string, args: ReadonlyArray<string>) =>
      spawner.exitCode(ChildProcess.make("git", [...args], { env })).pipe(
        Effect.mapError((error) => new Refused({ reason: `git ${step} failed: ${error.message}` })),
        Effect.flatMap((code) => code === 0 ? Effect.void : Effect.fail(new Refused({ reason: `git ${step} exited with code ${code}` })))
      )
    yield* run("init", init!)
    yield* run("fetch", fetch!)
    const tree = yield* spawner.string(ChildProcess.make("git", [...list!], { env })).pipe(
      Effect.mapError((error) => new Refused({ reason: `git ls-tree failed: ${error.message}` }))
    )
    yield* Effect.try({ try: () => checkTree(tree), catch: (error) => error as Refused })
    yield* run("checkout", check!)
  })

/** Refuses a fetched tree with links, submodules or more than the limits, before it is checked out. */
const checkTree = (listing: string) => {
  const records = listing.split("\0").filter((record) => record !== "")
  if (records.length === 0) throw new Refused({ reason: "the ref has no files" })
  if (records.length > limits.entries) throw new Refused({ reason: `the connector has more than ${limits.entries} files` })
  let total = 0
  for (const record of records) {
    const [meta = "", path = ""] = record.split("\t")
    const [mode, , , size] = meta.split(/ +/)
    if (mode === "120000") throw new Refused({ reason: `${path} is a link, and links are refused` })
    if (mode === "160000") throw new Refused({ reason: `${path} is a submodule, and submodules are refused` })
    total += Number(size)
    if (!(total <= limits.extractedBytes)) throw new Refused({ reason: `the connector is larger than ${limits.extractedBytes} bytes` })
  }
}
