import { describe, expect, it } from "@effect/vitest"
import { InstallMethod } from "@exangelos/service"

describe("InstallMethod.detect", () => {
  it("names the formula of a binary inside the Homebrew Cellar", () => {
    expect(InstallMethod.detect("/opt/homebrew/Cellar/exangelos/1.0.0/bin/exangelos")).toEqual(
      InstallMethod.InstallMethod.Homebrew({ formula: "exangelos" })
    )
  })

  it("names the bundle of a binary inside a desktop app", () => {
    expect(InstallMethod.detect("/Applications/Exangelos.app/Contents/MacOS/exangelos")).toEqual(
      InstallMethod.InstallMethod.AppBundle({ bundle: "/Applications/Exangelos.app" })
    )
  })

  it("treats any other path as a standalone binary", () => {
    expect(InstallMethod.detect("/home/me/.local/bin/exangelos")).toEqual(InstallMethod.InstallMethod.Standalone())
  })
})
