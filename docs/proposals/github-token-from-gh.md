# GitHub token from `gh`

Status: proposal. The main case already works and needs no code.

## Question

Can the github-pr connector take its token from `gh auth token` at configure time, and still keep it in the keychain?

## What exists

The CLI already does this for any secret field. `exangelos connector configure` takes `--secret-command key=<shell command>` (`apps/cli/src/commands/Management.ts:154-157`). The CLI runs the command with `sh -c`, reads its stdout, drains stderr, strips one final newline, and fails if the command exits non-zero (`apps/cli/src/commands/Secrets.ts:35-58`). The value goes to the daemon in `ConfigureConnector`. The daemon stores secret fields in the macOS Keychain (or Secret Service on Linux) as service `exangelos.<connector>`, account `<field>`. When neither is available it falls back to a mode-0600 secrets file (`adapters/secrets/src/SecretStores.ts:9,60-73`). The spec names this case: an agent configures a secret "by naming a command or a file, such as `gh auth token`" (`docs/spec.md:55`, `docs/spec.md:222`).

github-pr declares a `token` secret and an optional `host` for GitHub Enterprise (`connectors/github-pr/src/GithubPr.ts:85-87`). `host` is a secret destination, so the CLI refuses it as plain `key=value` and it must come from a secret source too (`apps/cli/src/commands/Management.ts:139-144,180-186`). The daemon stores the new values first (`packages/application/src/connectors/management.ts:197-207`), then github-pr asks GitHub who the token belongs to. A 401 makes configure fail and leaves the connector Rejected with those values stored; when GitHub is unreachable, rate-limited or answers not found, the values are accepted unchecked (`connectors/github-pr/src/GithubPr.ts:92-106`).

For github.com:

```sh
exangelos connector configure github-pr \
  --secret-command 'host=printf %s github.com' \
  --secret-command 'token=gh auth token --hostname github.com'
```

For a GitHub Enterprise host, name the same host twice:

```sh
exangelos connector configure github-pr \
  --secret-command 'host=printf %s ghe.example.com' \
  --secret-command 'token=gh auth token --hostname ghe.example.com'
```

Leaving `host` out keeps whatever host was configured before, so pass it explicitly.

## Security notes

- **Scope.** `gh auth login` asks for `repo`, `read:org` and `gist` by default, and more if the user added scopes. That is much more than reading pull requests needs. A fine-grained token limited to the watched repositories with read-only permissions is narrower. Using gh's token is a convenience trade the user makes knowingly.
- **Stale copy.** The store holds a copy taken at configure time. Replacing the token in gh (`gh auth refresh`, a new `gh auth login`) does not change the stored copy, which keeps working until GitHub revokes or expires it. Once GitHub rejects it, polls fail with 401, github-pr reports `CredentialsRejected` (`connectors/github-pr/src/GithubPr.ts:128-129`), and the connector shows as Rejected. Running configure again helps only once gh holds a valid token for that host; if gh still returns the rejected one, the same token is stored again. Nothing refreshes it automatically.
- **Host matching.** The `host` and `--hostname` values must match. A mismatch sends that token to the wrong GitHub host during the configure check. The values are stored before the check, so a refused token still leaves them in place with the connector Rejected, and an unchecked one stays until the first poll fails. Changing `host` later clears the stored secrets (`packages/domain/src/ConnectorRules.ts:87-94`).
- **Environment.** `sh -c` inherits the CLI's environment. gh prefers a token from the environment over its saved login: `GH_TOKEN` or `GITHUB_TOKEN` for github.com, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` for an Enterprise host. If one is set, the stored token may not be the user's gh login.
- **Printing.** The CLI never echoes the value. An agent must run the configure command and must not run `gh auth token` on its own, or the token lands in its transcript.
- **Which process runs gh.** The CLI runs the command in the user's shell session, where gh and its login are available. The connector runs under the daemon, which on macOS is a launchd job with a minimal PATH and no guarantee that gh is installed or logged in there. Running gh from the connector on each poll would avoid the stale copy, but gh and a usable login would have to be present in the daemon's environment, and the token would bypass the secret store.

## Options

**A. Document the existing flag.** Add the two commands above to the github-pr connector's README and to the agent-facing instructions.

**B. A github-pr shortcut**, such as `--token-from-gh`, that expands to the commands above.

- Pros: easier to discover; fills `host` and `--hostname` from one value.
- Cons: connector-specific behaviour in a generic CLI command, for no new capability.

**C. The connector reads the token from gh on each poll.**

- Pros: never stale.
- Cons: gh and its login needed in the daemon's environment, no stored copy, and a token that changes under the connector without a configure step.

## Recommendation

Option A. The CLI already supports this through `--secret-command`, the value goes to the secret store (the Keychain on a normal macOS install), and the agent never sees it. Document the github.com and Enterprise commands with `host` and `--hostname` matched, recommend a fine-grained token for users who want a narrow scope, and say that after a 401 the user refreshes gh's login for that host (or makes a new token) and then runs configure again. No code change and no new flag.
