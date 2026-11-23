import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { checkIcon, maxIconBytes, readIcon } from "@exangelos/connector-directory"

const svg = new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- mark --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>`)
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

const temporary = Effect.acquireRelease(
  Effect.promise(async () => Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "connector-icon-")))),
  (directory) => Effect.promise(() => Fs.rm(directory, { recursive: true, force: true }))
)

describe("checkIcon", () => {
  it("accepts an SVG and a PNG as base64 with their media type", () => {
    expect(checkIcon("icon.svg", svg)).toEqual(
      Result.succeed({ mediaType: "image/svg+xml", data: Buffer.from(svg).toString("base64") })
    )
    expect(checkIcon("logo/Icon.PNG", png)).toEqual(
      Result.succeed({ mediaType: "image/png", data: Buffer.from(png).toString("base64") })
    )
  })

  it.each([
    ["icon.gif", svg, "is not an .svg or .png"],
    ["icon.svg", new Uint8Array(maxIconBytes + 1), "over the 32768 byte limit"],
    ["icon.svg", new TextEncoder().encode("<html><svg/></html>"), "is not an SVG image"],
    ["icon.svg", new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0x3e]), "is not an SVG image"],
    ["icon.png", svg, "is not a PNG image"]
  ])("refuses %s with the wrong bytes", (name, bytes, reason) => {
    expect(Result.getFailure(checkIcon(name, bytes))).toEqual(expect.objectContaining({ value: expect.stringContaining(reason) }))
  })
})

describe("readIcon", () => {
  it.live("reads an icon inside the connector and refuses one that leads outside it", () =>
    Effect.gen(function*() {
      const root = yield* temporary
      const connector = Path.join(root, "connector")
      yield* Effect.promise(async () => {
        await Fs.mkdir(Path.join(connector, "art"), { recursive: true })
        await Fs.writeFile(Path.join(connector, "art", "icon.svg"), svg)
        await Fs.writeFile(Path.join(root, "outside.svg"), svg)
        await Fs.symlink(Path.join(root, "outside.svg"), Path.join(connector, "escape.svg"))
      })

      const icon = yield* readIcon(connector, "art/icon.svg")
      const outside = yield* Effect.flip(readIcon(connector, "../outside.svg"))
      const escape = yield* Effect.flip(readIcon(connector, "escape.svg"))
      const folder = yield* Effect.flip(readIcon(connector, "art"))
      const missing = yield* Effect.flip(readIcon(connector, "missing.png"))

      expect(icon.mediaType).toBe("image/svg+xml")
      expect(outside).toContain("is outside the connector")
      expect(escape).toContain("leads outside the connector")
      expect(folder).toContain("is not a file")
      expect(missing).toContain("does not exist")
    }).pipe(Effect.scoped))
})
