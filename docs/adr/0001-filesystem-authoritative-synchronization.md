# Filesystem-authoritative synchronization and restart recovery

Status: Superseded for runtime lifecycle details by the shared-engine contract in
`src/engine/composition.ts`, `src/engine/runtime.ts`, and the synchronization
section of `CLAUDE.md`.

This ADR still records the filesystem-authoritative goal. Its older lifecycle
details, such as full rebuild on plain resync, HTTP `409` for busy resync, and
publication readiness only after initial pass completion, no longer describe the
current shared-engine implementation.

The source filesystem is authoritative, and the published library is derived from it.
We choose gradual publication and restart recovery to keep synchronization simple.
Intermediate RSS and OPML may differ during processing; after source changes stop and processing completes, both must reflect the current library.

## Agreed guarantees

- A synchronization pass completes when its covered changes are reflected in RSS and OPML, including their related updates. Queuing events alone does not complete the pass; HTTP `202` means that a request was accepted.
- Reconciliation repairs differences using the existing cache. Resync forces a complete rebuild of derived state and may clear the cache.
- Shutdown finishes the active operation within a bounded timeout. It does not need to drain the entire pending queue.
- The next startup must recover unfinished publication from the source filesystem, including RSS and OPML updates that did not complete before shutdown.

## Coordination and readiness

- Initial sync, reconciliation, and resync share one active synchronization pass, from scanning through completed publication. A cache reset starts only after the active handler finishes, with new cache writes paused during the reset.
- Source watcher notifications remain accepted into the queue during synchronization and cache resets. Shutdown ends admission of new work.
- Event admission is ready once the queue is prepared. Publication is ready after the initial synchronization pass completes; later updates may publish gradually.
- The active shutdown operation is one handler, not a whole synchronization pass. Shutdown applies during startup, reconciliation, and resync: it stops new operations and allows the active operation to finish within the overall timeout.

## Completion and failure

- A pass covers the work discovered by its scan and the related publication updates. New watcher notifications continue through normal processing without extending the pass indefinitely.
- A resync request during an active pass receives HTTP `409`; it is not deferred. A scheduled reconciliation skips a busy interval and waits for the next one.
- A handler's cache or publication write failure does not stop independent work, but the pass is unsuccessful. An unsuccessful initial pass does not make publication ready; a later reconciliation or manual resync must attempt recovery.
- Handlers return the events needed for mandatory related updates. Successful publication and pass completion must not depend on delivery of data watcher notifications, which may provide additional hints.

## Source changes and publication recovery

- Watcher notifications request a check of the current source state. A delayed deletion notification must not remove the publication of a newer file at the same path.
- Initial sync and reconciliation reuse valid, fresh cached episode metadata. Missing, invalid, or stale metadata is rebuilt from the source audio file.
- Initial sync and reconciliation restore RSS and OPML even when no audio metadata needs to be reread. Cache reuse must not hide unfinished publication.
- A synchronization pass rebuilds OPML once, after its other publication work completes. Normal watcher processing updates OPML when podcast membership or podcast information changes; duplicate pending OPML requests may be coalesced.

These guarantees avoid an atomic switch of the whole library and make recovery independent of retaining the in-memory event queue.
