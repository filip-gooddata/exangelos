# GitHub token from `gh`

Status: proposal. The main case already works and needs no code.

## Question

Can the github-pr connector take its token from `gh auth token` at configure time, and still keep it in the keychain?

## What exists

The CLI already does this for any secret field. `exangelos configure` takes `--secret-command key=<shell command>` (`apps/cli/src/commands/Management.ts:154-157`). The CLI runs the command with `sh -c`, reads its stdout, drains stderr, strips one final newline, and fails with the exit code if the command fails (`apps/cli/src/commands/Secrets.ts:35-58`). The value goes to the daemon in `ConfigureConnector`, and the daemon stores secret fields in the keychain as service `exangelos.<connector>`, account `<field>` (`adapters/secrets/src/SecretStores.ts:9`). The spec names this case: an agent configures a secret "by naming a command or a file, such as `gh auth token`" (`docs/spec.md:55`, `docs/spec.md:222`).

github-pr declares a `token` secret and an optional `host` for GitHub Enterprise (`connectors/github-pr/src/GithubPr.ts:85-87`). Configure checks the token against GitHub before accepting it.

For github.com:

```sh
exangelos configure github-pr --secret-command 'token=gh auth token'
```

For a GitHub Enterprise host:

```sh
exangelos configure github-pr host=ghe.example.com \
  --secret-command 'token=gh auth token --hostname ghe.example.com'
```

## Security notes

- **Scope.** `gh auth login` asks for `repo`, `read:org` and `gist` by default, and more if the user added scopes. That is much more than reading pull requests needs. A fine-grained token limited to the watched repositories with read-only permissions is narrower. Using gh's token is a convenience trade the user makes knowingly.
- **Stale copy.** The keychain holds a copy taken at configure time. If gh later replaces or revokes its token (`gh auth logout`, `gh auth refresh`, a new `gh auth login`), the stored copy stops working. Polls then fail with 401, github-pr reports `CredentialsRejected` (`connectors/github-pr/src/GithubPr.ts:128-129`), and the connector shows as Rejected. Running the same configure command again fixes it. Nothing refreshes it automatically.
- **Host matching.** Without `--hostname`, `gh auth token` returns the github.com token. For Enterprise the command must name the same host as the `host` field, or configure fails its check against GitHub. Changing `host` later requires the secrets again (`packages/domain/src/ConnectorRules.ts:88-94`).
- **Environment.** `sh -c` inherits the CLI's environment. If `GH_TOKEN` or `GITHUB_TOKEN` is set there, gh uses it, so the stored token may not be the user's gh login.
- **Printing.** The CLI never echoes the value. An agent must run the configure command and must not run `gh auth token` on its own, or the token lands in its transcript.
- **Which process runs gh.** The CLI runs the command in the user's shell session, where gh and its login are available. The connector process runs under the daemon, which on macOS is a launchd job with a minimal PATH and no guarantee that gh is installed or logged in for that context. Running gh from the connector on each poll would avoid the stale copy, but it would mean a connector spawning programs, which the runtime does not do for any connector today, and it would bypass the keychain.

## Options

**A. Document the existing flag.** Add the two commands above to the github-pr connector's README and to the agent-facing instructions.

**B. A github-pr shortcut**, such as `--token-from-gh`, that expands to the command above.

- Pros: easier to discover.
- Cons: connector-specific behaviour in a generic CLI command, for no new capability.

**C. The connector reads the token from gh on each poll.**

- Pros: never stale.
- Cons: a subprocess from the connector process, gh needed in the daemon's environment, no keychain copy, and a token that changes under the connector without a configure step.

## Recommendation

Option A. The CLI already supports this through `--secret-command`, the value goes to the keychain, and the agent never sees it. Document the github.com and Enterprise commands, recommend a fine-grained token for users who want a narrow scope, and say that a 401 after a gh re-login means running configure again. No code change and no new flag.
