import { execFileSync } from "node:child_process"

const macOnlyFlags = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : []

export const createTarGz = (archive: string, root: string, entries: ReadonlyArray<string>): void => {
  execFileSync("tar", [...macOnlyFlags, "-czf", archive, "-C", root, "--", ...entries], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "ignore", "inherit"]
  })
}

export const extractTarGz = (archive: string, destination: string): void => {
  execFileSync("tar", ["-xzf", archive, "-C", destination], { stdio: ["ignore", "ignore", "inherit"] })
}

export const listTarGz = (archive: string): ReadonlyArray<string> =>
  execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
