import { describe, expect, it } from "@effect/vitest"
import { cleanValue, scrub } from "../src/commands/Debug.ts"

describe("debug report redaction", () => {
  it("hides values that text pairs with a sensitive name, quoted or not", () => {
    expect(scrub("password=\"correct horse battery staple\" next")).toBe("password=\"[redacted]\" next")
    expect(scrub("apiKey=abc123 retry")).toBe("apiKey=[redacted] retry")
    expect(scrub("{\"apiToken\": \"a b\", \"n\": 1}")).toBe("{\"apiToken\": \"[redacted]\", \"n\": 1}")
    expect(scrub("{\\\"secret\\\":\\\"x \\\\ y\\\"}")).toBe("{\\\"secret\\\":\\\"[redacted]\\\"}")
    expect(scrub("Authorization: Bearer eyJ.abc-def")).not.toContain("eyJ")
    expect(scrub("Cookie: sid=first; session=second\nnext line")).toBe("Cookie: [redacted]\nnext line")
  })

  it("hides credentials in URLs, such as a connector's git origin", () => {
    const origin = cleanValue({ _tag: "Git", url: "https://user:example-password@git.example/repo.git", ref: "main" })
    expect(origin).toEqual({ _tag: "Git", url: "https://[redacted]@git.example/repo.git", ref: "main" })
    expect(cleanValue({ _tag: "Archive", url: "https://cdn.example/c.tar.gz?sig=abc123&exp=1#part" })).toEqual({
      _tag: "Archive",
      url: "https://cdn.example/c.tar.gz?[redacted]"
    })
  })
})
