import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { packagingDirectory, repositoryDirectory } from "../src/release.ts"

const workflowsDirectory = join(repositoryDirectory, ".github", "workflows")

const loadWorkflow = <A>(file: string): A =>
  JSON.parse(
    execFileSync("ruby", ["-ryaml", "-rjson", "-e", "puts YAML.load_file(ARGV[0]).to_json", join(workflowsDirectory, file)], {
      encoding: "utf8"
    })
  )

interface BuildWorkflow {
  readonly env: Record<string, string>
  readonly jobs: { readonly binaries: { readonly steps: ReadonlyArray<Step> } }
}

interface Step {
  readonly uses?: string
  readonly run?: string
  readonly with?: Record<string, string>
  readonly env?: Record<string, string>
}

interface ReleaseWorkflow {
  readonly jobs: {
    readonly build: { readonly uses: string; readonly with: Record<string, string> }
    readonly "publish-tap": { readonly needs: ReadonlyArray<string>; readonly steps: ReadonlyArray<Step> }
  }
}

const buildRunSteps = (): ReadonlyArray<string> =>
  loadWorkflow<BuildWorkflow>("build-release.yml").jobs.binaries.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))

describe("release workflow", () => {
  it("builds with the install and the packaging scripts a local run uses", () => {
    const scripts = (JSON.parse(readFileSync(join(packagingDirectory, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts
    const pnpmSteps = buildRunSteps().filter((step) => step.startsWith("pnpm "))
    expect(pnpmSteps[0]).toBe("pnpm install --frozen-lockfile")
    for (const step of pnpmSteps.slice(1)) {
      const match = /^pnpm --filter @exangelos\/packaging run (\S+)(?: .*)?$/.exec(step)
      expect(match, step).not.toBeNull()
      expect(Object.keys(scripts)).toContain(match![1])
    }
  })

  it("builds the computed version and points it at the download address of that version's release", () => {
    const build = loadWorkflow<ReleaseWorkflow>("release.yml").jobs.build
    expect(build.uses).toBe("./.github/workflows/build-release.yml")
    expect(build.with.version).toBe("${{ needs.version.outputs.version }}")
    expect(loadWorkflow<BuildWorkflow>("build-release.yml").env.VERSION).toBe("${{ inputs.version }}")
    expect(buildRunSteps()).toContain(
      'pnpm --filter @exangelos/packaging run build:release --version "$VERSION" --release-url "https://github.com/$GITHUB_REPOSITORY/releases/download/v$VERSION"'
    )
  })

  it("pushes only the rendered formula to the tap, after the release its URLs point at exists", () => {
    const uploads = loadWorkflow<BuildWorkflow>("build-release.yml").jobs.binaries.steps.filter((step) => step.with?.name === "homebrew-formula")
    expect(uploads.map((step) => step.with?.path)).toEqual(["packaging/dist/homebrew-tap/Formula/exangelos.rb"])
    const publish = loadWorkflow<ReleaseWorkflow>("release.yml").jobs["publish-tap"]
    expect(publish.needs).toEqual(expect.arrayContaining(["version", "build", "release"]))
    expect(publish.steps.find((step) => step.uses?.startsWith("actions/download-artifact"))?.with?.name).toBe("homebrew-formula")
    const push = publish.steps.find((step) => step.run?.includes("publish-homebrew-tap.sh"))
    expect(push?.run).toBe('.github/scripts/publish-homebrew-tap.sh homebrew-formula/exangelos.rb "$VERSION"')
    expect(push?.env?.HOMEBREW_TAP_DEPLOY_KEY).toBe("${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}")
  })
})
