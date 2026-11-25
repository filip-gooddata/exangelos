import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { renderCask, renderFormula, trayImageName } from "../src/homebrew.ts"
import { binaryArchiveName, targets } from "../src/release-files.ts"
import { temporaryDirectory } from "./helpers.ts"

const rubySyntax = (path: string): string => execFileSync("ruby", ["-c", path], { encoding: "utf8" })

describe("Homebrew definitions", () => {
  const work = temporaryDirectory("homebrew")
  const checksums = [
    ...targets.map((target, index) => ({ sha256: String(index).repeat(64), file: binaryArchiveName("1.0.0", target) })),
    { sha256: "a".repeat(64), file: trayImageName("1.0.0", "aarch64") },
    { sha256: "b".repeat(64), file: trayImageName("1.0.0", "x64") }
  ]
  const release = { version: "1.0.0", baseUrl: "file:///tmp/release", checksums }
  mkdirSync(join(work, "Formula"))
  mkdirSync(join(work, "Casks"))

  it("renders a formula that parses and installs the binary under both names with the daemon service", () => {
    const formula = renderFormula(release)
    writeFileSync(join(work, "Formula", "exangelos.rb"), formula)
    expect(rubySyntax(join(work, "Formula", "exangelos.rb"))).toBe("Syntax OK\n")
    expect(formula).toContain(`url "file:///tmp/release/exangelos-1.0.0-linux-arm64.tar.gz"\n      sha256 "${"3".repeat(64)}"`)
    expect(formula).toContain(`name macos: "exangelos.daemon", linux: "exangelos.daemon"`)
    expect(formula).toContain(`bin.install_symlink "exangelos" => "xng"`)
    expect(formula).toContain(`homepage "https://github.com/filip-gooddata/exangelos"`)
    expect(formula).toContain("exangelos skill install")
    expect(formula).toContain(`assert_equal "exangelos #{version}", shell_output("#{bin}/xng --version").strip`)
  })

  it("renders a cask that parses and links the sidecar under both names", () => {
    const cask = renderCask(release)
    writeFileSync(join(work, "Casks", "exangelos-app.rb"), cask)
    expect(rubySyntax(join(work, "Casks", "exangelos-app.rb"))).toBe("Syntax OK\n")
    expect(cask).toContain(`target: "xng"`)
    expect(renderCask({ ...release, checksums: checksums.slice(0, 4) })).toContain("sha256 :no_check")
  })
})
