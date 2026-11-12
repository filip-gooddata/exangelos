import { Effect, Random } from "effect"
import { Ids } from "@exangelos/domain"

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

const suffix = Effect.gen(function*() {
  let text = ""
  for (let index = 0; index < 8; index++) {
    text += alphabet[Math.floor((yield* Random.next) * alphabet.length)]
  }
  return text
})

export const subscriptionId = Effect.map(suffix, (text) => Ids.SubscriptionId.make(`sub_${text}`))
export const eventId = Effect.map(suffix, (text) => Ids.EventId.make(`evt_${text}`))
export const wakeId = Effect.map(suffix, (text) => Ids.WakeId.make(`wake_${text}`))
