import { PluginDirectory, PluginRepository, PluginRuntime } from "@exangelos/application"
import type { Plugin } from "@exangelos/domain"
import { Effect, Layer } from "effect"

const start = (installed: PluginDirectory.Installed) =>
  Effect.gen(function*() {
    const runtime = yield* PluginRuntime.PluginRuntime
    const repository = yield* PluginRepository.PluginRepository
    const failing: Plugin.Plugin = {
      name: installed.name,
      version: installed.version,
      origin: { _tag: "Directory", path: installed.directory },
      digest: installed.digest,
      trust: "enabled",
      configuration: { _tag: "Missing" },
      process: "failing"
    }
    yield* runtime.start({ name: installed.name, directory: installed.directory, entry: installed.entry, dev: false }).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.logError(error).pipe(Effect.andThen(repository.store(failing))),
        onSuccess: (process) =>
          Effect.gen(function*() {
            const running: Plugin.Plugin = { ...failing, catalogue: process.catalogue, process: "running" }
            yield* repository.store(running)
            yield* process.exited.pipe(
              Effect.tap(Effect.logError),
              Effect.andThen(repository.store({ ...running, process: "failing" })),
              Effect.forkScoped
            )
          })
      })
    )
  })

/** First cut: starts every installed plugin for as long as the layer lives and records its catalogue. */
export const layer = Layer.effectDiscard(
  Effect.gen(function*() {
    const directory = yield* PluginDirectory.PluginDirectory
    const installed = yield* directory.list
    yield* Effect.forEach(installed, start, { concurrency: "unbounded", discard: true })
  })
)
