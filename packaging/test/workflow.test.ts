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

interface Job {
  readonly environment?: string
  readonly env?: Record<string, string>
  readonly steps: ReadonlyArray<Step>
}

interface BuildWorkflow {
  readonly env: Record<string, string>
  readonly jobs: Record<string, Job> & { readonly binaries: Job }
}

interface Step {
  readonly name?: string
  readonly if?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Record<string, string>
  readonly env?: Record<string, string>
}

interface ReleaseWorkflow {
  readonly jobs: {
    readonly build: { readonly uses: string; readonly with: Record<string, string | boolean> }
    readonly "publish-tap": { readonly needs: ReadonlyArray<string>; readonly if: string; readonly steps: ReadonlyArray<Step> }
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

  it("renders the formula and the cask from the published release and pushes them to the tap, also when HEAD is already released", () => {
    const publish = loadWorkflow<ReleaseWorkflow>("release.yml").jobs["publish-tap"]
    expect(publish.needs).toEqual(["version", "release"])
    expect(publish.if).toBe(
      "${{ !cancelled() && needs.version.result == 'success' && (needs.release.result == 'success' || needs.version.outputs.skip == 'true') }}"
    )
    const runs = publish.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))
    expect(runs.join("\n")).toContain('gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --pattern SHA256SUMS')
    expect(runs.join("\n")).toContain("pnpm --filter @exangelos/packaging run render:homebrew")
    const push = publish.steps.find((step) => step.run?.includes("publish-homebrew-tap.sh"))
    expect(push?.run).toBe('.github/scripts/publish-homebrew-tap.sh "$RUNNER_TEMP/homebrew-tap" "$VERSION"')
    expect(push?.env?.HOMEBREW_TAP_DEPLOY_KEY).toBe("${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}")
  })

  it("signs the macOS files only in release builds, from the release environment, with the certificate in one step", () => {
    expect(loadWorkflow<ReleaseWorkflow>("release.yml").jobs.build.with.sign).toBe(true)
    expect(loadWorkflow<{ jobs: { build: { with: Record<string, unknown> } } }>("release-check.yml").jobs.build.with.sign).toBeUndefined()
    const jobs = loadWorkflow<BuildWorkflow>("build-release.yml").jobs
    for (const name of ["binaries", "tray-macos"]) {
      const job = jobs[name]!
      expect(job.environment, name).toBe("${{ inputs.sign && 'release' || '' }}")
      const certificateSteps = job.steps.filter((step) => JSON.stringify(step).includes("secrets.APPLE_CERTIFICATE"))
      expect(certificateSteps.map((step) => step.if), name).toEqual(["inputs.sign"])
      expect(job.steps.find((step) => step.run?.includes("security delete-keychain"))?.if, name).toBe("always() && inputs.sign")
    }
  })
})
