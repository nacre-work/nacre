# On-call

One primary and one secondary, rotating weekly, handover on Tuesday morning.
The secondary exists because the primary is allowed to sleep.

Pages come from Prometheus. The only gauge that pages on the index path is
`nacre_tombstones_pending_total` — a climbing backlog means a background pass
has stopped, and the runbook is in the infrastructure repository. Latency
alerts are informational and do not page.

If you are paged twice in one night, hand over in the morning and sleep. A tired
engineer making a change to a production database is how a small incident
becomes a long one.
