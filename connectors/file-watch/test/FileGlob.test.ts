import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { FileGlob } from "@exangelos/connector-file-watch"

const parse = (path: string, ignore?: Array<string>) =>
  Result.getOrThrow(FileGlob.parse({ path, ignore }, "/home/ada"))

describe("FileGlob", () => {
  it("expands ~ and watches the literal directory above the first wildcard", () => {
    const glob = parse("~/code/api-gateway/dist/**")

    expect(glob.glob).toBe("/home/ada/code/api-gateway/dist/**")
    expect(glob.base).toBe("/home/ada/code/api-gateway/dist")
    expect(glob.includes("main.js")).toBe(true)
    expect(glob.includes("assets/logo.svg")).toBe(true)
  })

  it("watches the parent of a path without wildcards for that name alone", () => {
    const glob = parse("/var/log/app.log")

    expect(glob.base).toBe("/var/log")
    expect(glob.depth).toBe(1)
    expect(glob.includes("app.log")).toBe(true)
    expect(glob.includes("other.log")).toBe(false)
  })

  it("ignores matching files and everything below a matching directory", () => {
    const glob = parse("~/code/**/*.ts", ["**/node_modules", "~/code/api/generated/**"])

    expect(glob.ignores("web/node_modules/react/index.ts")).toBe(true)
    expect(glob.ignores("api/generated/client.ts")).toBe(true)
    expect(glob.ignores("api/src/client.ts")).toBe(false)
  })

  it("refuses a relative glob", () => {
    expect(Result.isFailure(FileGlob.parse({ path: "dist/**" }, "/home/ada"))).toBe(true)
  })
})
