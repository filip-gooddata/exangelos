import type { Html } from "foldkit/html"
import type { Model } from "./Model.ts"
import { type H, header } from "./Parts.ts"

/** Stub until the plugin screens land. */
export const plugins = (h: H, model: Model): ReadonlyArray<Html> => [header(h, model, "Connectors")]

/** Stub until the plugin screens land. */
export const plugin = (h: H, model: Model, name: string): ReadonlyArray<Html> => [header(h, model, name)]
