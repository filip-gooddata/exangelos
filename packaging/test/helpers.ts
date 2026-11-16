import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "@effect/vitest"
import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { bunSpawner } from "../src/spawner.ts"

export const fixtures = join(import.meta.dirname, "fixtures")
export const standInBuildScript = join(fixtures, "stand-in-build.ts")
const helloConnectorFixture = join(fixtures, "hello-connector")

export const temporaryDirectory = (label: string): string => {
  const directory = mkdtempSync(join(tmpdir(), `xng-packaging-${label}-`))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

export const helloConnectorCopy = (directory: string): string => {
  const copy = join(directory, "hello-connector")
  cpSync(helloConnectorFixture, copy, { recursive: true })
  return copy
}

export const withRealPrograms = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.provide(effect, bunSpawner)

export const runWithRealPrograms = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.runPromise(withRealPrograms(effect))
