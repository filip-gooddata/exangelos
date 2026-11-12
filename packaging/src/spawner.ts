import { BunChildProcessSpawner, BunFileSystem, BunPath } from "@effect/platform-bun"
import { Layer } from "effect"

export const bunSpawner = BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))
