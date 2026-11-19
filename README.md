<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-on-dark.svg">
  <img src="assets/mark-on-light.svg" width="64" height="64" alt="">
</picture>

# Exangelos

## Debugging

Exangelos keeps its logs on your machine and sends nothing anywhere.

```sh
exangelos settings set logLevel=debug   # record more detail, applied without a restart
exangelos logs -f                       # follow the logs of the daemon, MCP server and CLI
exangelos debug report                  # write a redacted .tar.gz to attach to an issue
exangelos settings set logLevel=info    # back to the default
```

`exangelos logs` also takes `--level`, `--since 10m`, `--connector <name>`, `--source daemon|mcp|cli`, `-n <count>` and `--json`. The tray menu's "Make a debug report" writes the same archive and shows it in your file manager. Read the archive before you attach it: secrets are removed, but it holds your connector names, paths and recent activity.
