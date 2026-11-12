import { Data } from "effect"

export type InstallMethod = Data.TaggedEnum<{
  Homebrew: { readonly formula: string }
  AppBundle: { readonly bundle: string }
  Standalone: {}
}>

export const InstallMethod = Data.taggedEnum<InstallMethod>()

export const detect = (realProgramPath: string): InstallMethod => {
  const segments = realProgramPath.split("/")
  const cellar = segments.indexOf("Cellar")
  const formula = cellar === -1 ? undefined : segments[cellar + 1]
  if (formula !== undefined && formula !== "") {
    return InstallMethod.Homebrew({ formula })
  }
  const bundleEnd = segments.findIndex((segment, index) => segment.endsWith(".app") && segments[index + 1] === "Contents")
  if (bundleEnd !== -1) {
    return InstallMethod.AppBundle({ bundle: segments.slice(0, bundleEnd + 1).join("/") })
  }
  return InstallMethod.Standalone()
}
