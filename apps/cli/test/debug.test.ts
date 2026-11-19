import { describe, expect, it } from "@effect/vitest"
import { cleanValue, scrub } from "../src/commands/Debug.ts"

describe("debug report redaction", () => {
  it("hides values that text pairs with a sensitive name, quoted or not", () => {
    expect(scrub("password=\"correct horse battery staple\" next")).toBe("password=\"[redacted]\" next")
    expect(scrub("apiKey=abc123 retry")).toBe("apiKey=[redacted] retry")
    expect(scrub("{\"apiToken\": \"a b\", \"n\": 1}")).toBe("{\"apiToken\": \"[redacted]\", \"n\": 1}")
    expect(scrub("{\\\"secret\\\":\\\"x \\\\ y\\\"}")).toBe("{\\\"secret\\\":\\\"[redacted]\\\"}")
    expect(scrub("Authorization: Bearer eyJ.abc-def")).not.toContain("eyJ")
  })

  it("hides credentials in URLs, such as a connector's git origin", () => {
    const origin = cleanValue({ _tag: "Git", url: "https://user:example-password@git.example/repo.git", ref: "main" })
    expect(origin).toEqual({ _tag: "Git", url: "https://[redacted]@git.example/repo.git", ref: "main" })
  })
})
