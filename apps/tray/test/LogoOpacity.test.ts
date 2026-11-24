import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const css = readFileSync(new URL("../src/view/panel.css", import.meta.url), "utf8")

/** Each selector of a rule that lowers opacity or filters what it matches. */
const dimming = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /opacity:\s*0?\.\d|filter:/.test(body!))
  .flatMap(([, selectors]) => selectors!.split(",").map((selector) => selector.trim()))

const target = (selector: string) => selector.split(/\s*[\s>+~]\s*/).at(-1)!

describe("connector logos", () => {
  it("keep full opacity in every row state: no dimming rule reaches a logo or a whole row", () => {
    expect(dimming.length).toBeGreaterThan(0)
    const reachesLogo = dimming.filter((selector) => {
      const element = target(selector)
      const exceptLogos = element.includes(":not(.badge-logo)")
      return element.startsWith(".row") ||
        (element.replace(":not(.badge-logo)", "").includes("badge-logo")) ||
        (element.includes("badge-connector") && !exceptLogos)
    })
    expect(reachesLogo).toEqual([])
  })
})
