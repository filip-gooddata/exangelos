import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer } from "effect"
import { layerFetchHttpClient } from "@exangelos/plugin-import"
import { PluginImportSource } from "@exangelos/application"
import * as PluginDirectoryLive from "@exangelos/plugin-directory"
import * as PluginImportLive from "@exangelos/plugin-import"
import { pluginEntries, tarGz, zip } from "./fixtures.ts"

const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "compiled-probe-"))
const plugins = Path.join(root, "plugins")
await Fs.writeFile(Path.join(root, "a.tar.gz"), tarGz(pluginEntries("from-tar")))
await Fs.writeFile(Path.join(root, "b.zip"), zip(pluginEntries("from-zip")))
await Fs.writeFile(Path.join(root, "c.tar.gz"), tarGz([...pluginEntries("bad"), { path: "../escape.js", content: "x" }]))

const program = Effect.gen(function*() {
  const imports = yield* PluginImportSource.PluginImportSource
  for (const file of ["a.tar.gz", "b.zip", "c.tar.gz"]) {
    const result = yield* Effect.result(imports.place({ _tag: "ArchiveFile", path: Path.join(root, file) }))
    console.log(file, result._tag === "Success" ? `placed ${Path.relative(root, result.success)}` : `refused: ${result.failure.reason}`)
  }
  const digest = yield* PluginDirectoryLive.digestDirectory(Path.join(plugins, "from-tar"))
  console.log("digest from-tar", digest)
})

await Effect.runPromise(program.pipe(Effect.provide(PluginImportLive.layer({ directory: plugins }).pipe(
  Layer.provide(PluginDirectoryLive.layer({ directory: plugins })),
  Layer.provide(Layer.mergeAll(BunServices.layer, layerFetchHttpClient))
))))
await Fs.rm(root, { recursive: true, force: true })
