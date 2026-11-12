import { Context, Data, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface Notification {
  readonly title: string
  readonly body: string
}

export class NotificationFailed extends Data.TaggedError("NotificationFailed")<{
  readonly reason: string
}> {}

export class Notifications extends Context.Service<Notifications, {
  readonly show: (notification: Notification) => Effect.Effect<void, NotificationFailed>
}>()("@exangelos/notifications/Notifications") {}

const appleScript = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run"
]

const macOSCommand = (notification: Notification): ChildProcess.StandardCommand =>
  ChildProcess.make("osascript", [
    ...appleScript.flatMap((line) => ["-e", line]),
    "--",
    notification.title,
    notification.body
  ])

const linuxCommand = (notification: Notification): ChildProcess.StandardCommand =>
  ChildProcess.make("notify-send", ["--", notification.title, notification.body])

const makeLayer = (toCommand: (notification: Notification) => ChildProcess.StandardCommand) =>
  Layer.effect(
    Notifications,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return Notifications.of({
        show: (notification) => {
          const command = toCommand(notification)
          return Effect.scoped(
            Effect.gen(function*() {
              const handle = yield* spawner.spawn(command)
              const [stderr, exitCode] = yield* Effect.all([
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
                Stream.runDrain(handle.stdout)
              ], { concurrency: "unbounded" })
              if (exitCode !== 0) {
                return yield* new NotificationFailed({
                  reason: `${command.command} exited with ${exitCode}: ${stderr.trim()}`
                })
              }
            })
          ).pipe(
            Effect.catchTag("PlatformError", (error) => Effect.fail(new NotificationFailed({ reason: error.message })))
          )
        }
      })
    })
  )

export const layerMacOS: Layer.Layer<Notifications, never, ChildProcessSpawner.ChildProcessSpawner> = makeLayer(
  macOSCommand
)

export const layerLinux: Layer.Layer<Notifications, never, ChildProcessSpawner.ChildProcessSpawner> = makeLayer(
  linuxCommand
)
