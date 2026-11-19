import { describe, expect, it } from "@effect/vitest"
import { cleanRecord, cleanValue, scrub } from "../src/commands/Debug.ts"

describe("debug report redaction", () => {
  it("drops every line that names a credential or carries a URL with credentials or a query", () => {
    const text = [
      "booting",
      "password=\"correct horse battery staple\" next",
      "Cookie: prefs=\"blue\"; sid=private",
      "{\\\"secret\\\":\\\"x y\\\"}",
      "fetch https://user:pw@git.example/repo",
      "fetch https://cdn.example/c.zip?label=O'Neil&sig=private",
      "upstream returned Basic dXNlcjpmYWtl",
      "ready"
    ].join("\n")
    expect(scrub(text)).toBe(
      ["booting", ...Array.from({ length: 6 }, () => "[redacted line]"), "ready"].join("\n")
    )
  })

  it("keeps only scheme, host and path of URLs, such as a connector's origin", () => {
    expect(cleanValue({ _tag: "Git", url: "https://user:example-password@git.example/repo.git", ref: "main" }))
      .toEqual({ _tag: "Git", url: "https://git.example/repo.git", ref: "main" })
    expect(cleanValue({ _tag: "Archive", url: "https://cdn.example/c.zip?label=O'Neil&sig=private#part" }))
      .toEqual({ _tag: "Archive", url: "https://cdn.example/c.zip" })
    expect(cleanValue({ _tag: "Archive", url: "https://cdn.example/download/token=R4Probe123/connector.tgz" }))
      .toEqual({ _tag: "Archive", url: "https://cdn.example/[redacted]" })
  })

  it("leaves out payloads by default, also under a key an older redaction rewrote", () => {
    const record = {
      t: "2026-11-19T10:00:00.000Z",
      level: "DEBUG" as const,
      src: "daemon" as const,
      pid: 1,
      msg: "event",
      ann: { connector: "echo", payload: { note: "a" }, "[redacted]": { note: "b" } }
    }
    expect(cleanRecord(record, false).ann).toEqual({ connector: "echo" })
    expect(cleanRecord(record, true).ann).toEqual(record.ann)
  })
})
