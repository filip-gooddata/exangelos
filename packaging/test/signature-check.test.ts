import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { repositoryDirectory } from "../src/release.ts"

const script = join(repositoryDirectory, ".github", "scripts", "check-no-developer-id.sh")

const check = (...paths: ReadonlyArray<string>) => spawnSync(script, paths, { encoding: "utf8" })

const archive = (work: string, name: string, helper: string): string => {
  const folder = join(work, name)
  mkdirSync(folder)
  copyFileSync(helper, join(folder, "helper"))
  writeFileSync(join(folder, "connector.json"), "{}")
  const file = join(work, `${name}.tar.gz`)
  execFileSync("tar", ["-czf", file, "-C", folder, "."])
  return file
}

// /bin/ls is a universal binary whose slices Apple signed. Re-signing a slice ad hoc stands in for the core.
describe.runIf(process.platform === "darwin")("check-no-developer-id.sh", () => {
  it("fails on a connector archive holding a universal file signed by an identity on a slice the host does not run", () => {
    const work = mkdtempSync(join(tmpdir(), "signature-check-"))
    const slice = (arch: string) => {
      const file = join(work, `ls-${arch}`)
      execFileSync("lipo", ["-thin", arch, "/bin/ls", "-output", file])
      return file
    }
    const appleX64 = slice("x86_64")
    const adHocArm = slice("arm64e")
    execFileSync("codesign", ["--force", "--sign", "-", adHocArm])
    const adHocX64 = join(work, "ls-x86_64-adhoc")
    copyFileSync(appleX64, adHocX64)
    execFileSync("codesign", ["--force", "--sign", "-", adHocX64])
    const mixed = join(work, "mixed")
    execFileSync("lipo", ["-create", appleX64, adHocArm, "-output", mixed])
    const clean = join(work, "clean")
    execFileSync("lipo", ["-create", adHocX64, adHocArm, "-output", clean])

    const refused = check(archive(work, "mixed-connector", mixed))
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("carries a signature from a signing identity")
    expect(check(archive(work, "clean-connector", clean)).status).toBe(0)
    expect(spawnSync(script, ["--adhoc", clean], { encoding: "utf8" }).status).toBe(0)
    expect(spawnSync(script, ["--adhoc", mixed], { encoding: "utf8" }).status).toBe(1)
    expect(check(join(work, "missing")).status).toBe(1)

    const unsignedX64 = join(work, "ls-x86_64-unsigned")
    copyFileSync(appleX64, unsignedX64)
    execFileSync("codesign", ["--remove-signature", unsignedX64])
    const partly = join(work, "partly")
    execFileSync("lipo", ["-create", unsignedX64, adHocArm, "-output", partly])
    const partlyRefused = spawnSync(script, ["--adhoc", partly], { encoding: "utf8" })
    expect(partlyRefused.status).toBe(1)
    expect(partlyRefused.stderr).toContain("(x86_64) has no ad hoc signature")
    expect(check(partly).status).toBe(0)
  })

  it("fails when codesign cannot read one slice of a universal file", () => {
    const work = mkdtempSync(join(tmpdir(), "signature-check-"))
    const slices = ["x86_64", "arm64e"].map((arch) => {
      const file = join(work, `ls-${arch}`)
      execFileSync("lipo", ["-thin", arch, "/bin/ls", "-output", file])
      execFileSync("codesign", ["--force", "--sign", "-", file])
      return file
    })
    const universal = join(work, "universal")
    execFileSync("lipo", ["-create", ...slices, "-output", universal])
    expect(check(universal).status).toBe(0)
    const bin = join(work, "bin")
    mkdirSync(bin)
    const stub = join(bin, "codesign")
    writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = x86_64 ] && { echo "$a: unreadable slice" >&2; exit 1; }; done\nexec /usr/bin/codesign "$@"\n`
    )
    chmodSync(stub, 0o755)
    const refused = spawnSync(script, [universal], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("codesign could not read")
  })
})
