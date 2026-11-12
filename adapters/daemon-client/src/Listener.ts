import { Effect } from "effect"
import { createConnection } from "node:net"

export const answers = (path: string): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    const socket = createConnection({ path })
    const settle = (live: boolean) => () => {
      socket.destroy()
      resume(Effect.succeed(live))
    }
    socket.once("connect", settle(true))
    socket.once("error", settle(false))
    return Effect.sync(() => socket.destroy())
  })
