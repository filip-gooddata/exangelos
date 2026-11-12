# Conventions

## Packages

- Each package is `@exangelos/<directory>`; plugins are `@exangelos/plugin-<directory>`. `exports` points at `./src/index.ts`, and nothing is built for the workspace.
- `src/index.ts` re-exports each module as a namespace: `export * as Paths from "./Paths.ts"`.
- `domain` performs no I/O. `application` depends on `domain` only. `gap/*` depends on no Exangelos package. Library packages import nothing from Bun; only apps and Bun-hosted adapters do.
- Code carries no explanatory comments. A doc comment on a port method states the contract.

## Services and layers

- A port is a `Context.Service` class in `packages/application/src/ports`, keyed `"@exangelos/application/<Name>"`. Its shape names only domain and contract types.
- An adapter exports `layer` (and `make` when tests need it) built with `Layer.effect`. `Layer.effect` owns scoped acquisition; there is no `Layer.scoped`.
- Only apps compose layers. A library never provides a real adapter to itself.
- Use Effect's own modules wherever one exists: `Config` for the environment, `FileSystem`, `effect/process` for child processes, `Schedule` for retries, `effect/rpc` for both wires.

## Errors

- Expected failures are `Schema.TaggedError` classes with a few named fields. They go in the error channel and in the RPC `error` schema; a domain rule returns `Result` with them.
- Name the condition, not the operation: `PluginNotFound`, `BacklogOverLimit`, not `ListFailed`.
- Defects are bugs. Never catch them to turn them into expected errors.

## Tests

| Level | What it covers | Command |
|---|---|---|
| Unit | domain rules and transitions, one test each | `pnpm --filter @exangelos/domain test` |
| Use case | an application use case over the fakes from `@exangelos/application/testing` | `pnpm --filter @exangelos/application test` |
| Contract | an adapter against its real dependency: SQLite file, template plugin child, unix socket | `pnpm --filter <adapter> test` |
| End to end | the compiled binary in a temp `EXANGELOS_HOME`, outside `pnpm test` | `pnpm --filter @exangelos/cli e2e` |

- `pnpm typecheck` and `pnpm test` run everything through Turborepo. A run that matches no package or no test counts as a failure.
- A package that touches Bun APIs runs `bun run --bun vitest run`; the others run `vitest run`.
- Write tests with `@effect/vitest` (`it.effect`, `it.layer`). Test behaviour through public functions. Go light: no test for every branch.

## External commands

- Build the command with `ChildProcess.make` from `effect/process` and run it through the `ChildProcessSpawner` service. Never call `Bun.spawn` or `node:child_process` in a library.
- Apps provide `BunChildProcessSpawner.layer` from `@effect/platform-bun`.
- A test replaces the spawner with `Layer.succeed(ChildProcessSpawner, …)` that records the command and answers with fixed output and exit code. A contract test that needs the real program says so in its name.

## Standard output

In a plugin and in the MCP server, stdout carries protocol frames only. Logs and diagnostics go to stderr. The CLI writes its answers to stdout and its errors to stderr.

## Migrations

- Migrations live in `adapters/sqlite/src/migrations` as `NNNN_name.ts`, each with a default export: one Effect over `SqlClient` from `effect/sql`.
- Import it in `migrations/index.ts` and add it to the `Migrator.fromRecord` record under the key `"NNNN_name"`. Nothing is loaded from disk at run time.
- A merged migration never changes. A change is a new migration with the next number.
