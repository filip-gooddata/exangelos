import { Effect } from "effect"
import { Command } from "effect/cli"
import { WakeText } from "@exangelos/contracts"
import * as Agent from "./Agent.ts"
import * as Management from "./Management.ts"
import { Json } from "./Output.ts"

export const make = <
  const Extra extends ReadonlyArray<Command.Command.SubcommandEntry> = readonly [],
  const ExtraConnector extends ReadonlyArray<Command.Command.SubcommandEntry> = readonly []
>(extra: {
  readonly commands?: Extra
  readonly connectorCommands?: ExtraConnector
  /** Runs once the arguments parse, before any of the built-in commands. */
  readonly started?: Effect.Effect<void>
} = {}) => {
  const started = extra.started ?? Effect.void
  const logged = <const Name extends string, Input, E, R, ContextInput>(
    command: Command.Command<Name, Input, ContextInput, E, R>
  ) => Command.provideEffectDiscard(command, started)
  // Running `started` first keeps each command's type, which `map` over the tuple cannot express.
  const loggedAll = <const Commands extends ReadonlyArray<Command.Command.Any>>(commands: Commands): Commands =>
    commands.map((command) => logged(command)) as unknown as Commands
  const connector = Command.make("connector").pipe(
    Command.withDescription("Import, enable, disable, remove, configure and dev-link connectors"),
    Command.withSubcommands([...Management.connectorCommands, ...(extra.connectorCommands ?? [])]),
    logged
  )
  return Command.make(WakeText.command).pipe(
    Command.withDescription("Subscribe to events from external sources and get woken when they happen"),
    Command.withSubcommands([
      ...loggedAll(Agent.commands),
      connector,
      ...loggedAll(Management.commands),
      ...(extra.commands ?? [])
    ]),
    Command.withGlobalFlags([Json])
  )
}

