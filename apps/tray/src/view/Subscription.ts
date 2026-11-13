import type { Html } from "foldkit/html"
import type { Model } from "./Model.ts"
import { type H, header } from "./Parts.ts"

/** Stub until the subscription screen lands. */
export const subscription = (h: H, model: Model, _id: string): ReadonlyArray<Html> => [header(h, model, "Subscription")]
