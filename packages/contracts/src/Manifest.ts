import { Schema } from "effect"
import { Ids } from "@exangelos/domain"

export const fileName = "plugin.json"

export const Platform = Schema.Literals(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"])
export type Platform = typeof Platform.Type

export const Entry = Schema.TaggedUnion({
  Bundle: { path: Schema.NonEmptyString },
  Native: {
    paths: Schema.Struct({
      "darwin-arm64": Schema.optionalKey(Schema.NonEmptyString),
      "darwin-x64": Schema.optionalKey(Schema.NonEmptyString),
      "linux-arm64": Schema.optionalKey(Schema.NonEmptyString),
      "linux-x64": Schema.optionalKey(Schema.NonEmptyString)
    })
  }
})
export type Entry = typeof Entry.Type

export const Manifest = Schema.Struct({
  name: Ids.PluginName,
  version: Schema.NonEmptyString,
  entry: Entry
})
export type Manifest = typeof Manifest.Type
