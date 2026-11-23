import { describe, expect, it } from "@effect/vitest"
import { Ids, Limits, Settings } from "@exangelos/domain"
import { Duration, Effect, Result } from "effect"
import { Scene } from "foldkit/test"
import { Request } from "../src/state/Panel.ts"
import { editedSettings, eventAlertsKey, initial, makeUpdate, Message } from "../src/view/Model.ts"
import { iconOf } from "../src/view/Parts.ts"
import { view } from "../src/view/PanelView.ts"
import * as Fixtures from "./fixtures.ts"

const update = makeUpdate(() => Effect.void)
const ready = initial(Fixtures.quiet, Fixtures.now)
const id = Ids.SubscriptionId.make("sub_7f3k")

describe("panel update", () => {
  it("asks before cancelling and runs the request once you confirm", () => {
    const asked = update(ready, Message.Requested({ request: Request.Cancel({ id }) }))
    expect(asked.model.confirming?._tag).toBe("Cancel")
    expect(asked.commands ?? []).toHaveLength(0)

    const confirmed = update(asked.model, Message.Confirmed())
    expect(confirmed.model.confirming).toBeNull()
    expect(confirmed.model.busy).toBe(true)
    expect(confirmed.commands).toHaveLength(1)
  })

  it("sends the opposite of a subscription's alerts from its switch in Settings, without asking", () => {
    const turnOff = Request.SetEventAlerts({ id, eventAlerts: false })
    Scene.scene(
      { update, view },
      Scene.given(initial(Fixtures.quiet, Fixtures.now, { _tag: "Settings" })),
      Scene.click(Scene.label("Event alerts for Fix flaky checkout test")),
      Scene.Command.resolve(
        { name: "Perform", args: { request: turnOff }, effect: Effect.succeed(Message.Performed({ request: turnOff })) },
        Message.Performed({ request: turnOff })
      ),
      Scene.Command.expectNone()
    )
  })

  it("refuses to save a limit that is not a whole number above zero", () => {
    const edited = update(ready, Message.EditedSetting({ key: "backlogCount", value: "0" }))
    const saved = update(edited.model, Message.SavedSettings())
    expect(saved.model.notice).toEqual({ tone: "refused", text: "Backlog limit by count takes a whole number above zero." })
    expect(saved.commands ?? []).toHaveLength(0)
  })

  it("goes back to the list once a removal is done", () => {
    const onConnector = initial(Fixtures.needsYou, Fixtures.now, { _tag: "Connector", name: "jira" })
    const done = update(onConnector, Message.Performed({ request: Request.RemoveConnector({ name: Ids.ConnectorName.make("jira") }) }))
    expect(done.model.screen).toEqual({ _tag: "Connectors" })
    expect(done.model.busy).toBe(false)
  })

  it("keeps unsaved limits when a subscription's alerts switch finishes", () => {
    const editing = update(initial(Fixtures.quiet, Fixtures.now, { _tag: "Settings" }), Message.EditedSetting({ key: "backlogCount", value: "30" })).model
    const request = Request.SetEventAlerts({ id: Ids.SubscriptionId.make("sub_7f3k"), eventAlerts: false })
    expect(update(editing, Message.Performed({ request })).model.settings).toEqual({ backlogCount: "30" })
    expect(update(editing, Message.Performed({ request: Request.SetSettings({ settings: Settings.initial }) })).model.settings).toEqual({})
  })
})

describe("editedSettings", () => {
  it("reads each edit in its field's unit and keeps what you did not touch", () => {
    const result = editedSettings(Settings.initial, { wakeWindow: " 10 ", [eventAlertsKey]: "on" })
    const settings = Result.getOrThrow(result)
    expect(Duration.toMillis(settings.limits.wakeWindow)).toBe(10_000)
    expect(settings.limits.backlogCount).toBe(Limits.defaults.backlogCount)
    expect(settings.eventAlerts).toBe(true)
  })

  it("names the first field that holds no whole number", () => {
    expect(editedSettings(Settings.initial, { backlogAge: "1.5" })).toEqual(Result.fail("Backlog limit by age"))
  })
})

describe("panel view", () => {
  it("shows each open subscription's label and intent on the main screen", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready),
      Scene.expect(Scene.text("Fix flaky checkout test")).toExist(),
      Scene.expect(Scene.text("Waiting on checks and review for the checkout test fix.")).toExist()
    )
  })

  it("heads each session group with its title, keeps the id for hover and leaves raw subjects out of the rows", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready),
      Scene.expect(Scene.title("T3 Code session 5c1e0a4f-2b7d-4e19-9a63-0f8d2c41b7e5")).toHaveText(/Checkout CI cleanup/),
      Scene.expect(Scene.text("b81f3d02…")).toExist(),
      Scene.expect(Scene.text("Slack #releases")).toExist(),
      Scene.expect(Scene.text(/slack:0e6ec01d/)).toBeAbsent(),
      Scene.expect(Scene.text(/Expires in 6 days/)).toBeAbsent()
    )
  })

  it("shows a connector's logo where it has one and its initials where it has none", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready),
      Scene.expect(Scene.selector("img.badge-logo")).toExist(),
      Scene.expect(Scene.text("SL")).toExist()
    )
  })

  it("draws initials for a connector whose logo failed to load", () => {
    const connectors = Result.getOrThrow((Fixtures.quiet as Extract<typeof Fixtures.quiet, { _tag: "Ready" }>).connectors)
    const src = iconOf(ready, connectors, "github-pr")
    expect(src).toBeDefined()
    const broken = update(ready, Message.IconFailed({ src: src! })).model
    expect(iconOf(broken, connectors, "github-pr")).toBeUndefined()
    expect(iconOf(broken, connectors, "jira")).toBeDefined()
    Scene.scene({ update, view }, Scene.given(broken), Scene.expect(Scene.text("GP")).toExist())
  })
})
