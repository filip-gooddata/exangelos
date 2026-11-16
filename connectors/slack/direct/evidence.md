# Delayed snapshot evidence boundaries

This connector compares persisted snapshots. Disk observations cannot establish when an unpersisted action occurred, or prove that every intermediate action was retained.

The supported contract accepts unbounded snapshot staleness. Polling faster does not make the producer persist faster. No captured account inventory or live diagnostic output is included in the public source. Synthetic tests demonstrate parser and reconciliation behavior, not live-source completeness.
