import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

const source = Path.resolve(import.meta.dirname, "../../../plugins/template")

/** Builds the real template plugin into the directory: its `plugin.json` and the bundle at `dist/main.js`. */
export const buildTemplate = async (target: string) => {
  await Fs.mkdir(target, { recursive: true })
  execFileSync("bun", ["build", Path.join(source, "src", "main.ts"), "--target=bun", `--outfile=${Path.join(target, "dist", "main.js")}`], { stdio: "ignore" })
  await Fs.copyFile(Path.join(source, "plugin.json"), Path.join(target, "plugin.json"))
}

/** The built template as archive entries under the prefix: `plugin.json` and `dist/main.js`. */
export const templateEntries = async (scratch: string, prefix = "") => {
  await buildTemplate(scratch)
  return Promise.all(["plugin.json", "dist/main.js"].map(async (path) => ({
    path: `${prefix}${path}`,
    content: await Fs.readFile(Path.join(scratch, path), "utf8")
  })))
}
