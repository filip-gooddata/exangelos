import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { packagingDirectory, repositoryDirectory } from "../src/release.ts"

const workflowPath = join(repositoryDirectory, ".github", "workflows", "release.yml")

const workflowRunSteps = (): ReadonlyArray<string> =>
  JSON.parse(
    execFileSync("ruby", ["-ryaml", "-rjson", "-e", "puts YAML.load_file(ARGV[0]).fetch('jobs').values.flat_map { |j| j.fetch('steps') }.map { |s| s['run'] }.compact.to_json", workflowPath], {
      encoding: "utf8"
    })
  )

describe("release workflow", () => {
  it("only runs the install and the packaging scripts a local run uses", () => {
    const scripts = (JSON.parse(readFileSync(join(packagingDirectory, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts
    const steps = workflowRunSteps()
    expect(steps[0]).toBe("pnpm install --frozen-lockfile")
    for (const step of steps.slice(1)) {
      const match = /^pnpm --filter @exangelos\/packaging run (\S+)$/.exec(step)
      expect(match, step).not.toBeNull()
      expect(Object.keys(scripts)).toContain(match![1])
    }
  })
})
