import { Effect } from "effect"
import { output, run } from "./command.ts"

const macOnlyFlags = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []

export const createTarGz = (archive: string, root: string, entries: ReadonlyArray<string>) =>
  run("tar", [...macOnlyFlags, "--format=ustar", "-czf", archive, "-C", root, "--", ...entries], {
    env: { COPYFILE_DISABLE: "1" }
  })

export const extractTarGz = (archive: string, destination: string) => run("tar", ["-xzf", archive, "-C", destination])

export const listTarGz = (archive: string) =>
  output("tar", ["-tzf", archive]).pipe(
    Effect.map((listing): ReadonlyArray<string> => listing.split("\n").filter((line) => line !== ""))
  )
