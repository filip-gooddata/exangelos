import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

export const fixtures = join(import.meta.dirname, "fixtures")
export const standInEntry = join(fixtures, "stand-in-entry.ts")
export const helloPlugin = join(fixtures, "hello-plugin")

export const temporaryDirectory = (label: string): string => {
  const directory = mkdtempSync(join(tmpdir(), `xng-packaging-${label}-`))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
