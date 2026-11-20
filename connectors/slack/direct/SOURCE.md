# Persisted acquisition contract

After the host authorizes persisted-cache access and resolves a positional subject,
the connector sends its pinned request to `direct/source.py` on stdin. The request
contains the resolved root, workspace, owner, conversation, optional thread root,
private key and expected scope. Python 3.10+ and the vendored decoder read the
database without opening it for writing.

Success exits 0 with one JSON object and no stderr. Its fields are `scope`
(64 hex), `complete: true`, `messages`, `generation` (decimal string), and
`snapshot` (64 hex). Messages have keyed `id`, keyed `body`, boolean `reply`,
keyed individual `reactions`, boolean `reactionsComplete`, and the top-level
delivery fields `messageTs`, `conversationLabel`, `permalink`, and optional `sender`. Only messages
in explicitly selected persisted conversation containers are included. Completeness
means those containers decoded completely; it does not mean complete Slack history.
Missing reactions do not prevent acquisition and must never imply removals.
The existing diagnostic's stricter completeness behavior is preserved.

Scope binds the key, workspace, owner, sorted unique conversation selection and
optional thread root and the identities of both the configured root and database directories (device, inode, and birth time when available).
Snapshot is a stable keyed marker of sorted projected state, independent of
acquisition time and generation. Generation is the maximum persisted LevelDB
sequence of the selected Redux record and its blob metadata. Multiple matching
Redux records, conflicting latest keys, missing required logs/tables, unsupported
records and incomplete selected messages fail closed.

The TypeScript consumer must compare generations as arbitrary precision integers
within the same scope, reject lower generations, and reject equal generations
with different snapshot markers. Equal generation and snapshot is a duplicate.
An epoch/scope change requires a fresh baseline; do not compare events across it.
Directory replacement changes scope. In-place restore to lower sequences can be
rejected against the retained cursor. An in-place restore followed by writes past
the saved sequence, or filesystem identity reuse, cannot reliably be distinguished
from forward progress by this read-only command. Directory identity is a local
epoch discriminator, not a durable LevelDB database UUID. No cross-epoch ordering
is promised; never use wall clock or current time as a substitute generation.

Inventory checks bracket the full scan, including CURRENT, manifests, table/log
membership and blob files. Device/inode/size/mtime/ctime and directory membership
must stay unchanged. Log and manifest checksums are checked in addition to the
existing table and decoder guards. These checks detect mutations, but are not an
atomic snapshot or protection against adversarial metadata-preserving replacement.
Unsupported inline persistence fails as unavailable. Old logs/manifests and blob
files are conservatively included in checks, so unrelated churn or corruption can
also cause a retryable failure.

Limits: 64 KiB stdin, 1,000 unique selected conversations, 10,000 messages,
10,000 filesystem entries, 256 MiB inventoried file bytes, 32 MiB per file,
8 MiB output, plus the existing 16 MiB decoded payload, 100,000 records,
1,000,000 projection nodes and depth 48 limits. Failure exits 1 with empty stdout
and only `Slack persisted source unavailable.` on stderr. No exception details
or private identifiers are exposed. Caller retries failures without updating its
cursor; it should impose its own process timeout.

The owner has accepted unbounded snapshot staleness and missed intermediate
changes, waiving the former 60-second requirement. No browser or Teams path is
included.
