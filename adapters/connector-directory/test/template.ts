import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"

const source = Path.resolve(import.meta.dirname, "../../../connectors/template")

/** Builds the real template connector into the directory: its `connector.json`, its icon and the bundle at `dist/main.js`. */
export const buildTemplate = async (target: string) => {
  await Fs.mkdir(target, { recursive: true })
  execFileSync("bun", ["build", Path.join(source, "src", "main.ts"), "--target=bun", `--outfile=${Path.join(target, "dist", "main.js")}`], { stdio: "ignore" })
  await Fs.copyFile(Path.join(source, "connector.json"), Path.join(target, "connector.json"))
  await Fs.copyFile(Path.join(source, "icon.svg"), Path.join(target, "icon.svg"))
}
