From a committed checkout, run the installed Teams release checks with Bun, pnpm, Git and Python 3.10+ on PATH.

```sh
python3 connectors/teams/scripts/validate-release.py --source HEAD
```

For an integration in progress, add `--worktree` to overlay tracked and nonignored Teams files and the shared excerpt and app icon helpers from the checkout. The runner records their SHA-256 hashes. The packer defaults to the source revision. Use `--packer REV` to supply a different host and packer, and `--out DIR` for a fresh evidence directory outside the repository.

The runner exports the host into a temporary directory, installs frozen dependencies, builds the release archive, verifies its checksum, manifest inventory and installed directory digest, and starts its bundle through the host stdio runtime. It supplies synthetic homes and LevelDB fixtures. A Python shim and FIFO check that startup, unconfigured requests and consent do not invoke Python or read the fixture before a configured subscription request.

The lifecycle cases cover conversation and thread scopes, historical backfill, a fresh burst, edits and reactions, preview policy, restart and replay, legacy selection rejection and account portability. Host intake and delivery pass installed events to the T3 wake adapter, which executes a scratch CLI that captures arguments and stdin. The checks compare those captures to the expected agent command and rendered wake. They exercise host components directly without a daemon or a live T3 thread.

The evidence directory retains the archive, revision record, command outcomes, case log and installed-file inventories. Inventories compare contents, permissions, sizes, mtime and ctime after each connector process. Temporary build, install and synthetic data are removed.
