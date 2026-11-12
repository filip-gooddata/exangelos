import { Effect, Layer, Ref } from "effect"
import { ServiceManager, type Status } from "../ports/ServiceManager.ts"

/** `install` marks the service installed and `start` marks it installed and running. */
export const layerServiceManager = (initial: Status): Layer.Layer<ServiceManager> =>
  Layer.unwrap(Effect.map(Ref.make(initial), (status) =>
    Layer.succeed(ServiceManager, {
      status: Ref.get(status),
      install: Ref.update(status, (s) => ({ ...s, installed: true })),
      start: Ref.update(status, (s) => ({ ...s, installed: true, running: true }))
    })))
