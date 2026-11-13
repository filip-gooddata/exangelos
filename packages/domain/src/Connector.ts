import { Schema } from "effect"
import { Catalogue } from "./Catalogue.ts"
import { ConnectorName } from "./Ids.ts"
import { Actor } from "./Session.ts"

export const Origin = Schema.TaggedUnion({
  Official: { version: Schema.String },
  ArchiveFile: { path: Schema.String },
  HttpsLink: { url: Schema.String },
  Directory: { path: Schema.String },
  GitRepository: { url: Schema.String, ref: Schema.String },
  DevLink: { path: Schema.String }
})
export type Origin = typeof Origin.Type

export const Trust = Schema.Literals(["inert", "enabled", "dev"])
export type Trust = typeof Trust.Type

export const Configuration = Schema.TaggedUnion({
  Missing: {},
  Set: {},
  Rejected: { reason: Schema.String }
})
export type Configuration = typeof Configuration.Type

export const ProcessState = Schema.Literals(["stopped", "running", "restarting", "failing"])
export type ProcessState = typeof ProcessState.Type

export const Connector = Schema.Struct({
  name: ConnectorName,
  version: Schema.String,
  origin: Origin,
  digest: Schema.String,
  trust: Trust,
  catalogue: Schema.optionalKey(Catalogue),
  configuration: Configuration,
  configuredBy: Schema.optionalKey(Actor),
  process: ProcessState,
  unavailableSince: Schema.optionalKey(Schema.DateTimeUtc)
})
export type Connector = typeof Connector.Type
