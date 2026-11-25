<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-on-dark.svg">
  <img src="assets/mark-on-light.svg" width="64" height="64" alt="">
</picture>

# Exangelos

## Agent skill

The [exangelos skill](skills/exangelos/SKILL.md) teaches Claude Code and Codex to watch PRs, Jira issues and conversations with Exangelos. It ships inside the CLI, so its version matches the binary.

```sh
exangelos skill install            # both hosts; --claude or --codex for one
exangelos skill uninstall
exangelos skill show               # print it, for any other harness
```

It installs to `~/.claude/skills/exangelos` and `~/.agents/skills/exangelos`. Rerun `exangelos skill install` after each upgrade. It leaves an `exangelos` skill it did not write alone unless you pass `--force`.

## Debugging

Exangelos keeps its logs on your machine and sends nothing anywhere.

```sh
exangelos settings set logLevel=debug   # record more detail, applied without a restart
exangelos logs -f                       # follow the logs of the daemon, MCP server and CLI
exangelos debug report                  # write a redacted .tar.gz to attach to an issue
exangelos settings set logLevel=info    # back to the default
```

`exangelos logs` also takes `--level`, `--since 10m`, `--connector <name>`, `--source daemon|mcp|cli`, `-n <count>` and `--json`. The tray menu's "Make a debug report" writes the same archive and shows it in your file manager. Read the archive before you attach it: secrets are removed, but it holds your connector names, paths and recent activity.
