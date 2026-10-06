## What This Is

Podcast RSS + OPML feed generator for locally stored audiobooks. Watches `/audiobooks` directory, extracts ID3 metadata, generates per-folder `feed.xml` (podcast RSS 2.0) and root `feed.opml`. Subscribe in any podcast app.

## Quick Reference

| Instead of              | Use                         |
| ----------------------- | --------------------------- |
| `node`, `ts-node`       | `bun <file>`                |
| `npm install/run`       | `bun install/run`           |
| `jest`, `vitest`        | `bun test`                  |
| `express`               | `Bun.serve()`               |
| `fs.readFile/writeFile` | `Bun.file()`, `Bun.write()` |
| `execa`                 | ``Bun.$`cmd` ``             |
| `crypto`                | `Bun.hash()`                |
| `dotenv`                | Bun auto-loads .env         |
| `curl` in healthcheck   | `wget` (curl not in image)  |

## Task Completion Checklist

After completing any task:

```bash
bun run fix   # format:fix + lint:fix — zero warnings, zero errors policy
bun run test
npx knip      # check unused exports/deps
```

**MANDATORY:** Run `bun run test` and verify 0 failures BEFORE every commit. Never commit untested code. If tests fail — fix first, then commit.

**MANDATORY:** Update `CLAUDE.md` when changes affect architecture, dependencies, commands, gotchas, or project structure. CLAUDE.md is the single source of truth for project context.

## Development Workflow

Docker dev runs at http://localhost:8080 — do NOT run bun locally.
Gracefully shutdown after tests.

```bash
docker compose -f docker-compose.dev.yml up          # start
docker compose -f docker-compose.dev.yml logs -f     # logs
curl http://localhost:8080/feed.opml                 # test OPML
curl http://localhost:8080/Author/Book/feed.xml # test podcast RSS
curl -u admin:secret http://localhost:8080/resync    # force resync
```

## Environment Variables

| Variable             | Default       | Description                                       |
| -------------------- | ------------- | ------------------------------------------------- |
| `FILES`              | `/audiobooks` | Source audiobooks directory                       |
| `DATA`               | `/data`       | Generated metadata cache                          |
| `PORT`               | `3000`        | Internal Bun server port                          |
| `LOG_LEVEL`          | `info`        | debug \| info \| warn \| error                    |
| `DEV_MODE`           | `false`       | Enable Bun --watch hot reload                     |
| `ADMIN_USER`         | -             | /resync Basic Auth username                       |
| `ADMIN_TOKEN`        | -             | /resync Basic Auth password                       |
| `RATE_LIMIT_MB`      | `0`           | Streaming rate limit MB/s (0 = off)               |
| `RECONCILE_INTERVAL` | `1800`        | Periodic reconciliation seconds (0 = off, min 60) |

## Testing

**IMPORTANT:** Run tests via Docker, not locally!

```bash
bun run test       # unit + integration (in docker)
bun run test:e2e   # nginx + event logging (outside docker)
bun run test:all   # everything

# Isolate the external port when several worktrees run E2E tests
TEST_PORT=18086 TEST_BASE_URL=http://localhost:18086 bun run test:e2e

# Run specific test file
docker compose -f docker-compose.test.yml run --rm test bun test test/unit/effect/handlers/audio-sync.test.ts

bun --bun tsc --noEmit  # type check (locally is fine)
```

### Test Structure

```
test/
├── setup.ts             # Global test setup
├── helpers/             # Mock services, assertions, fs utils
├── fixtures/audio/      # Tagged/untagged MP3 fixtures
├── unit/                # Pure logic, no external deps
│   ├── audio/           # ID3 reader, cover finder tests
│   ├── rss/             # RSS + OPML generator tests
│   ├── utils/           # Image processing tests
│   └── effect/
│       ├── handlers/    # Handler unit tests (mock deps)
│       └── adapters/    # Adapter classification tests
├── integration/         # Requires docker (sharp, ffmpeg)
│   └── effect/          # Queue + cascade flow tests
└── e2e/                 # Full system tests
    ├── nginx.test.ts    # nginx routing, OPML, range requests
    ├── shutdown.test.ts # Real TERM, deadline expiry, captured-cache restart
    └── event-logging.test.ts  # Event lifecycle tracing
```

## Project Structure

```
src/
├── server.ts        # HTTP server + initial sync + DI setup
├── app-lifecycle.ts # Application lifecycle boundary for sync passes and readiness
├── http.ts          # Production HTTP handler for watcher admission, readiness, and resync
├── config.ts        # Environment configuration
├── constants.ts     # File constants (feed.xml, entry.xml, feed.opml, etc.)
├── scanner.ts       # File scanning, sync planning
├── types.ts         # Shared types (MIME_TYPES, AUDIO_EXTENSIONS)
├── watcher.sh       # inotifywait → POST /events
├── context.ts       # AppContext, HandlerDeps, buildContext()
├── queue.ts         # SimpleQueue<T> (unrolled linked list)
├── stopping.ts      # Filesystem guards with shared publication-lock identity
├── effect/          # Event handling (neverthrow + async/await)
│   ├── types.ts     # RawBooksEvent, RawDataEvent, EventType
│   ├── pass-lifecycle.ts # Synchronization pass ownership and completion tracking
│   ├── consumer.ts  # Event loop (AbortController-based)
│   ├── adapters/    # Raw → typed event conversion
│   │   ├── books-adapter.ts    # /audiobooks watcher events
│   │   ├── data-adapter.ts     # /data watcher events
│   │   └── sync-plan-adapter.ts # Initial sync → events
│   └── handlers/    # source-path-sync, audio-sync, folder-sync, opml-sync, etc.
├── audio/           # Audio metadata extraction
│   ├── types.ts     # AudioMetadata interface
│   ├── id3-reader.ts # music-metadata via parseBuffer() (NOT parseFile)
│   └── cover.ts     # Folder cover art finder
├── rss/             # Feed generation
│   ├── types.ts     # PodcastInfo, EpisodeInfo, OpmlOutline
│   ├── podcast-rss.ts # Podcast RSS 2.0 with iTunes namespace
│   └── opml.ts      # OPML 2.0 feed aggregation
├── logging/         # Structured logging
│   ├── types.ts     # LogLevel, LogContext
│   └── index.ts     # Flat JSON logger to stdout
└── utils/           # image (sharp), processor
```

## Architecture: Dual Server

```
nginx:80 (external)          Bun:3000 (localhost only)
├── /feed.opml → /data/      ├── GET /ready ← publication readiness
├── healthcheck → /ready     ├── POST /events/books ← books watcher
├── /{path} → /data files    ├── POST /events/data ← data watcher
├── /resync → auth → proxy   └── POST /resync ← nginx
└── /* → 404
```

## Architecture: Sync Lifecycle

Initial sync, reconciliation, and resync run through `ApplicationLifecycle` as lifecycle-owned passes. A pass tags its planned events and mandatory cascades, waits for active handlers and queued covered work, and preserves ownership through cascades of coalesced metadata events. It suppresses pass-scoped `FeedXmlCreated`/`FeedXmlChanged`/`FeedXmlDeleted` hints and writes one final `feed.opml` after covered RSS work completes. OPML collection and writing are serialized per filesystem service so ordinary watcher publication cannot race the pass-final write. Watcher admission is ready before publication readiness. A successful recovery pass can establish readiness after failed startup; nginx `GET /ready` proxies this state. Accepted synchronization decisions live in `docs/adr/0001-filesystem-authoritative-synchronization.md`.

Pass ownership belongs to a delivered event occurrence. Coalescing adopts the pending occurrence, so an older active handler at the same path cannot complete it or transfer its failures. `SimpleQueue.enqueue(event, true)` preserves a covered occurrence's queue position. Later ordinary duplicates coalesce into one ordinary follow-up instead of rotating covered work.

Resync reserves the pass before HTTP `202` returns. Any active pass causes HTTP `409` without a deferred request. `runResync()` pauses queue delivery and waits for active deliveries before deleting cache entries under the OPML publication lock. Source and data notifications remain queued during reset. A `finally` resumes delivery on success or failure. The rebuild rereads source metadata and uses normal pass-scoped RSS and final OPML completion. Reset clears publication readiness; successful rebuild restores it. `getActivePass()` exposes the owned task for lifecycle coordination. The server uses `createHttpHandler()` for the production HTTP boundary.

Source notifications enter through `ApplicationLifecycle.admitBooksEvent()`. They enqueue `SourcePathSyncRequested` hints, which check current filesystem state and reconcile directory descendants. Pending hints coalesce by path. Admission avoids TTL filtering because a repeated notification can describe a newer same-path replacement. Scan-planned deletions use the same current-state check. Audio metadata writes trigger folder RSS directly; folder RSS triggers parent navigation and OPML, including changes to existing podcast information. Empty cache branches are pruned only when their source subtree has no supported audio. `waitForIdle()` observes pending events and active consumer work for integration callers; pass completion remains scoped to the pass.

Source type changes remove the obsolete cache representation before rebuilding. Episode mirrors retain only `entry.xml`; folder mirrors remove that episode marker. Metadata requests for a path now occupied by supported audio reconcile the file rather than delete its new cache. Unsupported regular files remove obsolete mirrors and cannot become episodes. `src/effect/handlers/mirror-kind.ts` owns the representation cleanup.

### Publication Recovery

- OPML collection propagates directory, stat, read, and podcast XML errors. A failed collection leaves the previous OPML intact and fails the pass. Missing paths and valid navigation feeds are excluded normally.
- Root-level audio publishes a podcast at `/feed.xml`. Build feed and cover URLs from joined relative paths so the empty root path does not add a second slash.
- Scanner cache reuse requires a fresh `entry.xml` timestamp and valid episode XML, including source path identity, file size, MIME type, and usable dates and numbers. `src/rss/episode-cache.ts` owns this validation.
- Every pass regenerates the audio-derived folder hierarchy and RSS, even when all episode metadata is reusable. Final OPML publication repairs missing or stale navigation without watcher notifications.
- Cache scanning includes directories with missing metadata markers. Cleanup removes only the highest obsolete subtree so descendant cascades cannot recreate removed folders.
- `ApplicationLifecycle.startReconciliation()` owns interval scheduling. Busy intervals are skipped without a deferred run; the next configured interval retries. Interval `0` creates no timer. Pass failures retain their unsuccessful result while independent handlers continue.

### Bounded Shutdown

`runServer()` installs TERM and INT handling before it awaits context setup or starts initial synchronization. `ApplicationLifecycle.startProcessing()` owns the consumer. The lifecycle also owns the active pass and reconciliation task. `shutdown()` closes admission and readiness immediately, permanently stops queue delivery, and cancels pass completion waits. It gives the active handler up to 8 seconds to finish. It returns `completed` or `deadline`; the server then closes HTTP and exits. Pass setup, reset iterations, scans, and final OPML check stopping after awaited operations. An expired handler cannot begin another filesystem operation. Guarded filesystem services preserve the original OPML lock identity.

Queue `pause()`/`resume()` remain temporary reset controls. Permanent `stop()` cannot be undone by a reset's `finally`. Pending cascades stay unpublished at exit. A fresh initial pass repairs the remaining cache and publication from current sources.

`scanFiles()` and `createSyncPlan()` accept the lifecycle's optional `AbortSignal`. Source traversal, cache traversal, and metadata validation check it after awaited operations. Cancellation escapes the cache-reuse fallback so a stopped scan cannot start another read or stat.

The shell entrypoint forwards signals promptly and waits for Bun, nginx, and the watcher. Unexpected child exits fail the container. Watcher pipelines run in owned process groups so inotify and in-flight wget receive TERM together. Compose uses an init reaper and a 15-second stop grace period: the 8-second application budget plus bounded helper cleanup.

## Architecture: Event Processing

1. **Adapters** (`adapters/*.ts`) — raw inotify → typed EventType
2. **Queue** (`SimpleQueue<EventType>`) — unrolled linked list + Promise waiters; pending source-path and folder-metadata requests coalesce by path, ordinary OPML hints coalesce globally, and active deliveries remain counted until the consumer completes them
3. **Consumer** (`consumer.ts`) — `while (!signal.aborted)` loop with `queue.take(signal)`
4. **Handlers** (`handlers/*.ts`) — return `Result<EventType[], Error>` for cascades

### DI via AppContext + Pick<>

| Field in AppContext | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `config`            | filesPath, dataPath, port, reconcileInterval          |
| `logger`            | info, warn, error, debug (void, fire-and-forget)      |
| `fs`                | mkdir, rm, readdir, stat, atomicWrite (Promise-based) |
| `dedup`             | TTL-based (500ms) event filtering (synchronous)       |
| `queue`             | SimpleQueue: enqueue, enqueueMany, take, size         |
| `handlers`          | Map<tag, AsyncHandler>                                |
| `lifecycle`         | PassLifecycle for pass-scoped event completion        |

Handlers receive `HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">`.

### Key Patterns

**Cascade events** — handlers return events via neverthrow:

```typescript
return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }]);
```

**Flag cleanup** — use `try/finally`:

```typescript
isSyncing = true;
try {
  await doWork();
} finally {
  isSyncing = false;
}
```

**Graceful shutdown** — lifecycle ownership:

```typescript
const lifecycle = new ApplicationLifecycle(ctx);
lifecycle.startProcessing();
void lifecycle.runInitialSync();
// ...
const outcome = await lifecycle.shutdown();
await server.stop(true);
```

**Mirror structure** — /data mirrors /audiobooks:

- Source files and folders are authoritative; /data is a generated cache and RSS reflects the current library.
- Audio file → folder with `entry.xml`
- Folder with episodes → `feed.xml` + `cover.jpg` + `_entry.xml`
- Root → `feed.opml`

## Constraints & Gotchas

- `test/e2e/shutdown.test.ts` builds isolated production containers and mounts `shutdown-bootstrap.ts` through the internal `SERVER_MODULE` entrypoint seam. The bootstrap only gates real filesystem operations. The production server still owns signals, HTTP, handlers, and shutdown. Its tests use real TERM, Docker terminal states, child wait statuses, and captured cache across restart. Run it alone with `bun test test/e2e/shutdown.test.ts` or as part of `bun run test:e2e`.

- Anti-slop rules are vendored from `dmmulroy/anti-slop` at `tools/oxlint/anti-slop/`; `UPSTREAM.md` records the source revision. `bun run lint:anti-slop` checks owned JS/TS, including tests, and runs in a separate CI job. Oxlint and `@oxlint/plugins` are pinned together; `oxlint-tsgolint` matches Oxlint's peer requirement.

- `bun run test:e2e` uses `tools/test-e2e.sh`. It preserves compose-start and test failures through graceful cleanup; teardown failure also fails an otherwise successful run. `TEST_PORT` sets the external container port; set `TEST_BASE_URL` to the same port for the tests. Use a distinct `COMPOSE_PROJECT_NAME` per worktree. Folder watcher E2E tracing observes `SourcePathSyncRequested`; empty source folders stay outside the Catalog.

- Zod decodes watcher HTTP payloads and RSS metadata at their input boundaries. Handlers accept typed events. The logger decodes thrown values in `src/logging/error-schema.ts` and preserves string messages, Error stacks, and JSON object messages.

- **music-metadata**: `parseFile()` hangs in Bun — always use `parseBuffer()`
- **Healthcheck**: Docker image is Alpine without curl — use `wget`
- **Handlers return events, never call each other** — cascade via `EventType[]` return values, consumer enqueues them
- **data watcher ignores feed.xml/feed.opml writes** — otherwise infinite loop
- **Publication and log exclusions apply only to the data watcher.** The source watcher must observe directories such as `events.jsonl`, including their moves out of the Library.
- **Only entry.xml and \_entry.xml produce actionable events** from data watcher
- **M4B = single episode** — no chapter extraction, users must split beforehand
- **Supported audio**: .mp3 (audio/mpeg), .m4a (audio/mp4), .m4b (audio/mp4), .ogg (audio/ogg)
- **Episode ordering**: sort by `(disc, track, filename)` tuple from ID3, fallback to natural filename sort
- **Episode numbers in RSS**: assigned from 1 after sorting on every feed update; cached `episodeNumber` in entry.xml is ignored for RSS numbering

## Troubleshooting

### Infinite Loop in Watchers

- data watcher excludes feed.xml and feed.opml
- Only entry.xml and \_entry.xml produce actionable events
- `_entry.xml` changes should sync only the parent folder; syncing the same folder can re-trigger metadata writes
- Check watcher.sh exclusion patterns

### Tests Failing

- Always run tests in Docker: `bun run test`
- Rebuild Docker image after dependency changes: `bun run rebuild:test`
- Check test fixtures exist in test/fixtures/audio/

### Resync Not Working

- Requires ADMIN_USER + ADMIN_TOKEN environment variables
- nginx removes auth block if not configured
- Check entrypoint.sh AUTH_ENABLED logic

### Healthcheck Commands

Docker healthcheck uses nginx `GET /ready` with `wget` (NOT `curl` — not in alpine image):

```bash
wget -q --spider http://127.0.0.1/ready
```

## Agent skills

### Issue tracker

Track issues and specs in GitHub Issues for `Seigiard/opml-generator`. Before reading or publishing tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before applying triage labels, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain concepts or design decisions, read `docs/agents/domain.md`.
