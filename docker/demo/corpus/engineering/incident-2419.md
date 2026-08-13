# Incident 2419 — search returned four results for a top_k of five

Severity 2, no data loss, no unauthorized access.

A re-index left every previous point in the index. The symptom was reported by a
support engineer who noticed that a search asking for five results returned
four, which is the kind of detail a dashboard never shows.

Root cause: the delete of superseded points ran after the write of the new ones
and filtered on a field the new points also carried, so it removed one of them.
The error code in the worker log was `SQLSTATE 23505` on the retry, which sent
the first hour of the investigation toward a constraint that was not the
problem.

Fixed by flagging the points before the row is written, in that order, because
the reverse fails unrecoverably. The lesson recorded: a count that is quietly
one short is a defect that only a person counting will find.
