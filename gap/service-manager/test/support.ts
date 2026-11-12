import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import { Effect, FileSystem, Layer, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { ServiceDefinition, UserService } from "@exangelos/service-manager"
import * as FakeSpawner from "./FakeSpawner.ts"

export const awkward: ServiceDefinition = {
  label: "exangelos.daemon",
  program: "/opt/My Apps/xng",
  arguments: [`say "hi" & 50% $HOME`],
  environment: { GREETING: `a "b" & c 10% $X` },
  stdoutPath: "/tmp/x y/out.log",
  stderrPath: "/tmp/x y/err.log",
  description: `Exangelos & "friends" 100%`
}

export const inTempDirectory = <A, E>(
  body: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* body(yield* fs.makeTempDirectoryScoped())
    })
  ).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

export const provide = (
  layer: Layer.Layer<
    UserService,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >,
  fake: FakeSpawner.Fake
) => Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(fake.layer, NodeFileSystem.layer, NodePath.layer))))
