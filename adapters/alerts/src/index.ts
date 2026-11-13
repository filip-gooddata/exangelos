import { Effect, Layer, Match } from "effect"
import { AlertSink } from "@exangelos/application"
import { Notifications } from "@exangelos/notifications"
import type { Notification } from "@exangelos/notifications"

export const render: (alert: AlertSink.Alert) => Notification = Match.type<AlertSink.Alert>().pipe(
  Match.tagsExhaustive({
    WaitsForEnable: ({ connector }) => ({
      title: `${connector} waits to be enabled`,
      body: `Read its origin and checksum, then run: exangelos connector enable ${connector}`
    }),
    Failing: ({ connector, reason }) => ({ title: `${connector} keeps failing`, body: reason }),
    CredentialsRejected: ({ connector, reason }) => ({
      title: `${connector} credentials rejected`,
      body: `${reason}\nUpdate them with: exangelos connector configure ${connector}`
    }),
    DigestMismatch: ({ connector }) => ({
      title: `${connector} checksum does not match`,
      body: "The official connector's files differ from the checksum this binary carries, so it will not run."
    }),
    Event: ({ event, connector, subject }) => ({
      title: `${event.type} on ${subject}`,
      body: `${event.summary}\n${connector}, event #${event.number}`
    })
  })
)

export const layer: Layer.Layer<AlertSink.AlertSink, never, Notifications> = Layer.effect(
  AlertSink.AlertSink,
  Effect.gen(function*() {
    const notifications = yield* Notifications
    return AlertSink.AlertSink.of({
      show: (alert) =>
        notifications.show(render(alert)).pipe(
          Effect.mapError((error) => new AlertSink.AlertFailed({ reason: error.reason }))
        )
    })
  })
)
