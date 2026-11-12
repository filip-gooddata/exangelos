import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AlertSink } from "@exangelos/application"
import { Ids } from "@exangelos/domain"
import { NotificationFailed, Notifications } from "@exangelos/notifications"
import type { Notification } from "@exangelos/notifications"
import * as Alerts from "@exangelos/alerts"

const plugin = Ids.PluginName.make("github-pr")

const recording = (fail?: string) => {
  const shown: Array<Notification> = []
  const layer = Layer.succeed(Notifications, {
    show: (notification) =>
      fail === undefined
        ? Effect.sync(() => void shown.push(notification))
        : Effect.fail(new NotificationFailed({ reason: fail }))
  })
  return { shown, layer: Alerts.layer.pipe(Layer.provide(layer)) }
}

describe("Alerts", () => {
  it.effect("shows a rejected-credentials alert as a desktop notification", () =>
    Effect.gen(function*() {
      const notifications = recording()
      yield* AlertSink.AlertSink.use((sink) =>
        sink.show({ _tag: "CredentialsRejected", plugin, reason: "401 Bad credentials" })
      ).pipe(Effect.provide(notifications.layer))
      expect(notifications.shown).toEqual([{
        title: "github-pr credentials rejected",
        body: "401 Bad credentials\nUpdate them with: exangelos plugin configure github-pr"
      }])
    }))

  it.effect("fails with AlertFailed when the notification cannot be shown", () =>
    Effect.gen(function*() {
      const error = yield* AlertSink.AlertSink.use((sink) => sink.show({ _tag: "DigestMismatch", plugin })).pipe(
        Effect.provide(recording("notify-send exited with 1").layer),
        Effect.flip
      )
      expect(error).toEqual(new AlertSink.AlertFailed({ reason: "notify-send exited with 1" }))
    }))
})
