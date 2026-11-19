import { describe, expect, it } from "@effect/vitest"
import { cleanValue, scrub } from "../src/commands/Debug.ts"

describe("debug report redaction", () => {
  it("drops every line that names a credential or carries a URL with credentials or a query", () => {
    const text = [
      "booting",
      "password=\"correct horse battery staple\" next",
      "Cookie: prefs=\"blue\"; sid=private",
      "{\\\"secret\\\":\\\"x y\\\"}",
      "fetch https://user:pw@git.example/repo",
      "fetch https://cdn.example/c.zip?label=O'Neil&sig=private",
      "ready"
    ].join("\n")
    expect(scrub(text)).toBe(
      ["booting", ...Array.from({ length: 5 }, () => "[redacted line]"), "ready"].join("\n")
    )
  })

  it("keeps only scheme, host and path of URLs, such as a connector's origin", () => {
    expect(cleanValue({ _tag: "Git", url: "https://user:example-password@git.example/repo.git", ref: "main" }))
      .toEqual({ _tag: "Git", url: "https://git.example/repo.git", ref: "main" })
    expect(cleanValue({ _tag: "Archive", url: "https://cdn.example/c.zip?label=O'Neil&sig=private#part" }))
      .toEqual({ _tag: "Archive", url: "https://cdn.example/c.zip" })
  })
})
