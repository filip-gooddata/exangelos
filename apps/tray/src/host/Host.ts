import { Context, Effect, Layer, Schema } from "effect"

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export const HostInfo = Schema.Struct({
  smoke: Schema.Boolean,
  platform: Schema.Literals(["macos", "linux"])
})
export type HostInfo = typeof HostInfo.Type

export class HostCommandFailed extends Schema.TaggedError<HostCommandFailed>()("HostCommandFailed", {
  command: Schema.String,
  message: Schema.String
}) {}

export class Host extends Context.Service<Host, {
  readonly info: Effect.Effect<HostInfo, HostCommandFailed>
  readonly setAttention: (needsYou: boolean) => Effect.Effect<void, HostCommandFailed>
  readonly smokeReport: (
    result: { readonly ok: boolean; readonly report: string }
  ) => Effect.Effect<void, HostCommandFailed>
  readonly quit: Effect.Effect<void, HostCommandFailed>
}>()("@exangelos/tray/Host") {}

export const make = (invoke: Invoke): Host["Service"] => {
  const call = (command: string, args?: Record<string, unknown>) =>
    Effect.tryPromise({
      try: () => invoke(command, args),
      catch: (cause) => new HostCommandFailed({ command, message: String(cause) })
    })
  return Host.of({
    info: call("host_info").pipe(
      Effect.flatMap((info) =>
        Schema.decodeUnknownEffect(HostInfo)(info).pipe(
          Effect.mapError((error) => new HostCommandFailed({ command: "host_info", message: error.message }))
        )
      )
    ),
    setAttention: (needsYou) => Effect.asVoid(call("tray_set_attention", { needsYou })),
    smokeReport: ({ ok, report }) => Effect.asVoid(call("host_smoke_report", { ok, report })),
    quit: Effect.asVoid(call("tray_quit"))
  })
}

export const layer = (invoke: Invoke): Layer.Layer<Host> => Layer.succeed(Host)(make(invoke))
