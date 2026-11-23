import { Schema } from "effect"
import { Ids } from "@exangelos/domain"

export const fileName = "connector.json"

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
  name: Ids.ConnectorName,
  version: Schema.NonEmptyString,
  entry: Entry,
  files: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /**
   * The connector's logo: a path relative to the connector folder to an `.svg` or `.png` of at most 32 KiB.
   * Any value decodes, so a bad icon, even one that is not a string, leaves the connector without a logo
   * instead of refusing its manifest.
   */
  icon: Schema.optionalKey(Schema.Unknown)
})
export type Manifest = typeof Manifest.Type
