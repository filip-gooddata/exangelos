import { listPlugins } from "@exangelos/application"
import { DaemonContract } from "@exangelos/contracts"
import { Effect, Schema } from "effect"

export class NotImplemented extends Schema.TaggedError<NotImplemented>()("NotImplemented", {
  rpc: Schema.String
}) {}

const notImplemented = (rpc: string) => () => Effect.die(new NotImplemented({ rpc }))

export const layer = DaemonContract.DaemonContract.toLayer({
  ListPlugins: () => listPlugins,
  Subscribe: notImplemented("Subscribe"),
  Update: notImplemented("Update"),
  List: notImplemented("List"),
  Show: notImplemented("Show"),
  Events: notImplemented("Events"),
  Ack: notImplemented("Ack"),
  Wait: notImplemented("Wait"),
  Pause: notImplemented("Pause"),
  Resume: notImplemented("Resume"),
  Retarget: notImplemented("Retarget"),
  Cancel: notImplemented("Cancel"),
  ImportPlugin: notImplemented("ImportPlugin"),
  EnablePlugin: notImplemented("EnablePlugin"),
  DisablePlugin: notImplemented("DisablePlugin"),
  RemovePlugin: notImplemented("RemovePlugin"),
  ConfigurePlugin: notImplemented("ConfigurePlugin"),
  DevLink: notImplemented("DevLink"),
  DevUnlink: notImplemented("DevUnlink"),
  ListPluginAlerts: notImplemented("ListPluginAlerts"),
  GetSettings: notImplemented("GetSettings"),
  SetSettings: notImplemented("SetSettings"),
  ServiceStatus: notImplemented("ServiceStatus")
})
