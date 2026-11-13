import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Manifest } from "@exangelos/contracts"
import packageJson from "../package.json" with { type: "json" }
import manifest from "../connector.json" with { type: "json" }

describe("manifest", () => {
  it("validates and names the bundle the build writes", () => {
    const decoded = Schema.decodeUnknownSync(Manifest.Manifest)(manifest)

    expect(decoded).toMatchObject({ name: "github-pr", entry: { _tag: "Bundle" } })
    if (decoded.entry._tag === "Bundle") {
      expect(packageJson.scripts.build).toContain(`--outfile=${decoded.entry.path}`)
    }
  })
})
