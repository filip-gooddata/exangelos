# Persisted state contract

The connector reads delayed persisted state. Source persistence is independent of polling, so staleness is unbounded and intermediate changes can be missed. Event time is observation time rather than the original action time. This limitation is accepted by the supported connector contract.

For public format provenance see producer-report.md and vendor/SOURCES.md. Historical local-source comparisons and account-derived inventories are not included in this publication.
