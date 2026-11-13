import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { packagingDirectory, releaseTagMismatch, repositoryDirectory } from "../src/release.ts"

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
      const match = /^pnpm --filter @exangelos\/packaging run (\S+)(?: .*)?$/.exec(step)
      expect(match, step).not.toBeNull()
      expect(Object.keys(scripts)).toContain(match![1])
    }
  })

  it("gives the release build the download address of the version's GitHub release", () => {
    expect(workflowRunSteps()).toContain(
      'pnpm --filter @exangelos/packaging run build:release --release-url "https://github.com/${{ github.repository }}/releases/download/v$(jq -r .version packaging/package.json)"'
    )
  })

  it("fails a tag run whose tag is not v<version> and passes the matching tag", () => {
    expect(releaseTagMismatch("v0.2.0", "0.1.0")).toBe("Tag v0.2.0 does not match the package version: expected v0.1.0")
    expect(releaseTagMismatch("v0.1.0", "0.1.0")).toBeUndefined()
  })
})
