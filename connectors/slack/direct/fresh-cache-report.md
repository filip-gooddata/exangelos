# Snapshot freshness limitations

There is no guaranteed relationship between polling time and source persistence time. The connector accepts delayed disk snapshots with unbounded staleness. Intermediate changes may be absent from the next persisted state. See ../README.md for the supported contract.

Installed application fingerprints and local investigation records are omitted from public source.
