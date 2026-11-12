import { Effect, Option } from "effect"
import { PluginRules } from "@exangelos/domain"
import { OfficialPluginSource } from "../ports/OfficialPluginSource.ts"
import { PluginRepository } from "../ports/PluginRepository.ts"

/**
 * One alert for each plugin that waits for the owner because of its trust. An official plugin is
 * checked against the checksum this binary carries for its name, so one the owner disabled, whose
 * files still match, has no alert.
 */
export const listPluginAlerts = Effect.gen(function*() {
  const { known } = yield* OfficialPluginSource
  const plugins = yield* PluginRepository.use((repository) => repository.list)
  const checksum = (name: string) =>
    Option.map(Option.fromNullishOr(known.find((official) => official.name === name)), (official) => official.digest)
  return plugins.flatMap((plugin) => Option.toArray(PluginRules.trustAlert(plugin, checksum(plugin.name))))
})
