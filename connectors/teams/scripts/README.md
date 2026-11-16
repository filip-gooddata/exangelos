Run the bounded release contract from a committed checkout:

```sh
python3 connectors/teams/scripts/validate-release.py --source HEAD
```

The default packer is pinned to `75e07311b13bdc1569f7732b89efe682f7406d9b`. The runner exports it with `git archive`, overlays only committed `connectors/teams`, installs frozen dependencies, checks Effect 4.1.4, and invokes the actual packaging CLI. It requires Bun, pnpm, Git and Python 3.10+ on PATH. `--out` selects an external evidence directory; use a fresh directory. No worktree is created.

The lifecycle contract executes the installed bundle through `StdioConnectorRuntime`, in the install directory with an explicit environment excluding source Python imports and test bytecode suppression. Synthetic cache/config fixtures are generated outside that directory and removed after testing. It checks deferred Configure, preconfiguration sentinels, missing requirements, silent baseline/idle, edited-message delivery, durable replay after process restart, and forbidden installed ledger/setup paths. FIFO metadata plus a Python shim establishes preconfiguration isolation; it is not an operating-system syscall trace. Idle observations span two polling intervals.

Sorted hash and metadata inventories exclude access time, which reads can change. They include file/directory paths, mode, size, mtime and ctime. Evidence contains command/cwd/exit/deadline records, exact revisions, archive hash, case results and inventories; no private fixture content. Source tests are not included in the manifest or release archive. The runner removes build/install trees and synthetic fixtures, retaining the archive and evidence. Each command and lifecycle scope has a finite deadline; production timeout behavior is unchanged.
