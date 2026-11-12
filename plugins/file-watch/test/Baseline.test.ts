import { describe, expect, it } from "@effect/vitest"
import { Baseline } from "@exangelos/plugin-file-watch"

describe("Baseline", () => {
  it("reports nothing on resume for a file already reported just before the cursor", () => {
    const now = Date.now()
    const files = new Map([["fresh.js", { modifiedAt: now, size: 3, bornAt: now }]])
    const cursor = Baseline.encodeCursor(files, now - 2000)

    expect(Baseline.diff(Baseline.decodeCursor(cursor)!, files)).toEqual([])
  })
})
