import { Effect, Option } from "effect"
import { PluginRules } from "@exangelos/domain"
import { OfficialPluginSource } from "../ports/OfficialPluginSource.ts"
import { PluginRepository } from "../ports/PluginRepository.ts"

export const listPluginAlerts = Effect.gen(function*() {
  const { known } = yield* OfficialPluginSource
  const plugins = yield* PluginRepository.use((repository) => repository.list)
  const checksum = (name: string) =>
    Option.map(Option.fromNullishOr(known.find((official) => official.name === name)), (official) => official.digest)
  return plugins.flatMap((plugin) => Option.toArray(PluginRules.trustAlert(plugin, checksum(plugin.name))))
})
