# OPML review fixes phase 1

## Commits

- `7fba09c` `fix: repair shared engine OPML cascades`

## Finding to test/fix matrix

| Finding | Calibrated red | Green evidence | Fix |
| --- | --- | --- | --- |
| Vanished audio file re-enqueued itself forever | `test/engine/episode-sync.test.ts` failed with `completed: false`, `state: working`, and repeated target lstat count `220` before the fix. | Same test now passes in Docker. | `SourcePathSyncRequested` cascades now run through `sourcePathSync`; missing files become cleanup work, not another `EpisodeWork`. |
| Dropped `FolderDeleted` cascade kept stale RSS/OPML | Folder delete and folder rename tests failed with old feed still present and stale OPML URLs. | Same tests now pass in Docker. | Added `FolderDeleteWork` and wired `FolderDeleted` to `folderCleanup`, including parent refresh. |
| Folder RSS work was never declared | Missing `feed.xml` test failed with ENOENT; folder processing version bump wrote `0` feeds. | Missing RSS repair, folder version bump, and unchanged skip tests now pass in Docker. | Every pass declares folder work for current source audio folders and cached stale folders; folder freshness controls skip/rebuild. |
| Audio file replaced by same-name directory deleted new child output | Type-change test failed with invalid/empty OPML before the fix. | Same test now passes in Docker. | Obsolete episode deletes are declared before new episode creates. |
| Content freshness hashed full audio files | Metadata-equivalent plain-pass tests went red against old content hashing. | Metadata-equivalent plain pass skips; watcher hint and force pass reprocess. | Episode freshness now uses `metadata`; changed-path hints and force pass handle intentional reprocessing. |
| SIGTERM before first pass reported false startup failure | Runtime test covers stop-before-ready and ready fulfillment; smoke still checks SIGTERM exit 0. | Runtime test and `SMOKE_PROJECT=opml49_review_fix_smoke SMOKE_PORT=18088 bun run smoke:engine` pass. | Runtime resolves ready on abort; server `ready.catch` ignores failures after shutdown starts. |
| Malformed `/events/books` JSON caused unhandled rejection | New HTTP test would throw on old `req.json()` path. | Runtime/HTTP unit test passes in Docker. | Extracted `createServerFetch`; malformed JSON returns clean `400 Invalid event`. |
| False-green resync/smoke tests | Resync-auth now proves published RSS corruption before repair; smoke corrupts/deletes derived RSS before force/restart checks. | Targeted e2e resync-auth and smoke pass. | Strengthened tests and removed `OPML_SYNC_ENGINE` assertion. |
| Clear minors: stale docs, write-only registry, data watcher | Typecheck/knip caught registry fallout while removing dead handlers. | `bun --bun tsc --noEmit`, `npx knip`, targeted handler tests pass. | Removed handler registry and unreachable handlers/tests; removed data watcher and `/events/data`; updated docs/ADR. |

## Not fixed in phase 1

- Removed in-process 8 second shutdown deadline: reported only, per prompt. Current documented behavior is that the entrypoint watchdog and compose stop grace bound shutdown. Restoring an application-level deadline remains an open decision.
- `@seigiard/sync-engine` pin was not changed. It remains `0.5.0` as requested; phase 2 owns the `0.5.1` release pin bump and full gates.

## Verification

- Red calibration: `COMPOSE_PROJECT_NAME=opml49_review_fix_phase1 docker compose -f docker-compose.test.yml run --rm test bun test test/engine/episode-sync.test.ts` failed with 7 expected failures on old code.
- Green: `COMPOSE_PROJECT_NAME=opml49_review_fix_phase1 docker compose -f docker-compose.test.yml run --rm test bun test test/engine/episode-sync.test.ts`.
- Green: `COMPOSE_PROJECT_NAME=opml49_review_fix_phase1 docker compose -f docker-compose.test.yml run --rm test bun test test/unit/engine/runtime.test.ts`.
- Green: `COMPOSE_PROJECT_NAME=opml49_review_fix_phase1 docker compose -f docker-compose.test.yml run --rm test bun test test/unit/effect/handlers.test.ts test/unit/effect/handlers/audio-sync.test.ts test/unit/effect/handlers/folder-cleanup.test.ts`.
- Green: `COMPOSE_PROJECT_NAME=opml49_review_fix_e2e TEST_PORT=18087 TEST_BASE_URL=http://localhost:18087 bun test test/e2e/resync-auth.test.ts`, with the matching e2e compose project started and stopped around the test.
- Green: `SMOKE_PROJECT=opml49_review_fix_smoke SMOKE_PORT=18088 bun run smoke:engine`.
- Green: `bun run fix`.
- Green: `bun --bun tsc --noEmit`.
- Green: `npx knip`.

Full suites were not run in phase 1, per prompt.
