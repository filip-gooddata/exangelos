> Legacy fallback. New installations should use the connector Configuration fields described in [the README](../README.md); this script is not required for normal setup.

# Private selection bootstrap

Run this yourself in an unrecorded terminal after authorizing local cache access.
Choose a distinctive literal snippet from a message in the conversation you want
selected. Do not send the snippet to an agent or put it in command arguments,
shell history, logs, or a chat. The prompt hides input and refuses an echoing
fallback. No authentication material, API, network, browser, or app mutation is
used. Only the requested output file is created.

From the repository root, choose a new private output path:

```sh
mkdir -p "$HOME/.config/exangelos"
python3 connectors/slack/direct/private_selection.py --output "$HOME/.config/exangelos/slack-request.json"
```

Enter the snippet at `Cached message snippet (hidden):` and press Enter. Success
exits 0 with no stdout and no further stderr. The prompt itself is generic.
Alternatively, redirect stdin from a private UTF-8 file created outside chat,
command arguments and shell history:

```sh
python3 connectors/slack/direct/private_selection.py --output "$HOME/.config/exangelos/slack-request.json" < "$HOME/.config/exangelos/slack-snippet.txt"
```

File input is matched literally, including any trailing newline; save the file
without a final newline unless it is part of the desired snippet. Input is limited
to 64 KiB and must not be empty. For a nondefault cache directory, add
`--root /absolute/path/to/IndexedDB`; this optional path is nonsecret. Without it,
the standard macOS Slack IndexedDB directory is used.

The command scans decoded cached message text in-process with the existing
`scan.py` decoder. Matching is case-sensitive literal substring matching, without
regexes or whitespace normalization. Several matching messages are accepted only
when they identify exactly one workspace, owner and conversation. Another match
in a different workspace, owner, or conversation makes selection ambiguous.
`source.acquire` validates the entire selected scope before the file is created;
inventory checks bracket both scans. This retains the [source contract](SOURCE.md)
limits and coherence limitations, including the lack of an atomic snapshot.

The JSON file contains `selection: {workspace, owner, conversations: [conversation]}`
and a fresh random 64-hex-character `key`; an explicit `--root` also adds the
resolved `root` path. Creation is exclusive, mode 0600, and never overwrites an
existing file or follows an existing output symlink. It prints no selected IDs,
names, message bodies, context, or key. All failures exit 1 with empty stdout and
only `Slack private selection unavailable.` on stderr. A failed selection leaves
no new request. An existing output is preserved. Choose a different new output
path if necessary; do not print the old file to diagnose it.

A snippet visible in Slack may be absent on disk. Persistence may lag indefinitely,
cache coverage is partial, and intermediate changes can be missed. The owner has
accepted those limitations and waived the former 60-second bound. Failure may also
mean ambiguity, incomplete persisted messages, cache churn, or an unavailable cache;
no private diagnostic details are revealed. A failed attempt grants no permission
to inspect other app data or obtain credentials.

Keep the request private and retain its key for the same selection across restarts.
Give the parent integration only the nonsecret request-file path so its local
process can read it; do not paste the JSON. Use the aggregate-only SDK acquisition
check in [the connector README](../README.md); do not print source.py output or
protocol frames. This bootstrap does not register, configure, or enable a
connector. No live acquisition was executed while implementing this procedure.

Synthetic seam checks:

```sh
python3 -m unittest discover -s connectors/slack/direct -p test_select.py
```
