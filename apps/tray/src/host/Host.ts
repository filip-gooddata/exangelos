import { Context, Effect, Layer, Schema } from "effect"

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export const HostInfo = Schema.Struct({
  smoke: Schema.Boolean,
  platform: Schema.Literals(["macos", "linux"])
})
export type HostInfo = typeof HostInfo.Type

export class Host extends Context.Service<Host, {
  readonly info: Effect.Effect<HostInfo>
  readonly setAttention: (needsYou: boolean) => Effect.Effect<void>
  readonly smokeReport: (result: { readonly ok: boolean; readonly report: string }) => Effect.Effect<void>
}>()("@exangelos/tray/Host") {}

export const make = (invoke: Invoke): Host["Service"] => {
  const call = (command: string, args?: Record<string, unknown>) => Effect.promise(() => invoke(command, args))
  return Host.of({
    info: call("host_info").pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostInfo)), Effect.orDie),
    setAttention: (needsYou) => Effect.asVoid(call("tray_set_attention", { needsYou })),
    smokeReport: ({ ok, report }) => Effect.asVoid(call("host_smoke_report", { ok, report }))
  })
}

export const layer = (invoke: Invoke): Layer.Layer<Host> => Layer.succeed(Host)(make(invoke))
