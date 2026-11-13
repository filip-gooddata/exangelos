import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { ConfigProvider, Effect, Layer } from "effect"
import { layerFetchHttpClient } from "@exangelos/connector-import"
import { ConnectorImportSource } from "@exangelos/application"
import { Paths } from "@exangelos/paths"
import * as ConnectorDirectoryLive from "@exangelos/connector-directory"
import * as ConnectorImportLive from "@exangelos/connector-import"
import { connectorEntries, tarGz, zip } from "./fixtures.ts"

const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "compiled-probe-"))
const connectors = Path.join(root, "connectors")
await Fs.writeFile(Path.join(root, "a.tar.gz"), tarGz(connectorEntries("from-tar")))
await Fs.writeFile(Path.join(root, "b.zip"), zip(connectorEntries("from-zip")))
await Fs.writeFile(Path.join(root, "c.tar.gz"), tarGz([...connectorEntries("bad"), { path: "../escape.js", content: "x" }]))

const program = Effect.gen(function*() {
  const imports = yield* ConnectorImportSource.ConnectorImportSource
  for (const file of ["a.tar.gz", "b.zip", "c.tar.gz"]) {
    const result = yield* Effect.result(imports.place({ _tag: "ArchiveFile", path: Path.join(root, file) }))
    console.log(file, result._tag === "Success" ? `placed ${Path.relative(root, result.success)}` : `refused: ${result.failure.reason}`)
  }
  const digest = yield* ConnectorDirectoryLive.digestDirectory(Path.join(connectors, "from-tar"))
  console.log("digest from-tar", digest)
})

const paths = Paths.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ EXANGELOS_HOME: root }))), Layer.orDie)
await Effect.runPromise(program.pipe(Effect.provide(ConnectorImportLive.layer.pipe(
  Layer.provide(ConnectorDirectoryLive.layer),
  Layer.provide(Layer.mergeAll(BunServices.layer, layerFetchHttpClient, paths))
))))
await Fs.rm(root, { recursive: true, force: true })
