import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { Manifest } from "@exangelos/connector-sdk"

describe("Manifest", () => {
  it("decodes a connector.json that names its icon", () => {
    const json = { name: "my-connector", version: "0.1.0", entry: { _tag: "Bundle", path: "dist/main.js" }, icon: "icon.svg" }
    expect(Schema.decodeUnknownSync(Manifest.Manifest)(json).icon).toBe("icon.svg")
  })
})
