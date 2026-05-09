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
curl http://localhost:8080/data/Author/Book/feed.xml # test podcast RSS
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
    └── event-logging.test.ts  # Event lifecycle tracing
```

## Project Structure

```
src/
├── server.ts        # HTTP server + initial sync + DI setup
├── config.ts        # Environment configuration
├── constants.ts     # File constants (feed.xml, entry.xml, feed.opml, etc.)
├── scanner.ts       # File scanning, sync planning
├── types.ts         # Shared types (MIME_TYPES, AUDIO_EXTENSIONS)
├── watcher.sh       # inotifywait → POST /events
├── context.ts       # AppContext, HandlerDeps, buildContext()
├── queue.ts         # SimpleQueue<T> (unrolled linked list)
├── effect/          # Event handling (neverthrow + async/await)
│   ├── types.ts     # RawBooksEvent, RawDataEvent, EventType
│   ├── consumer.ts  # Event loop (AbortController-based)
│   ├── adapters/    # Raw → typed event conversion
│   │   ├── books-adapter.ts    # /audiobooks watcher events
│   │   ├── data-adapter.ts     # /data watcher events
│   │   └── sync-plan-adapter.ts # Initial sync → events
│   └── handlers/    # audio-sync, folder-sync, opml-sync, etc.
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
├── /feed.opml → /data/      ├── POST /events/books ← books watcher
├── /data/* → static files   ├── POST /events/data ← data watcher
├── /resync → auth → proxy   └── POST /resync ← nginx
└── /* → 404
```

## Architecture: Event Processing

1. **Adapters** (`adapters/*.ts`) — raw inotify → typed EventType
2. **Queue** (`SimpleQueue<EventType>`) — unrolled linked list + Promise waiters; pending `FolderMetaSyncRequested` events are coalesced by path and moved behind later queued work
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

**Graceful shutdown** — AbortController:

```typescript
const controller = new AbortController();
const consumerTask = startConsumer(ctx, controller.signal);
// ...
server.stop();
controller.abort();
await Promise.allSettled([consumerTask, reconcileTask]);
```

**Mirror structure** — /data mirrors /audiobooks:

- Audio file → folder with `entry.xml`
- Folder with episodes → `feed.xml` + `cover.jpg` + `_entry.xml`
- Root → `feed.opml`

## Constraints & Gotchas

- **music-metadata**: `parseFile()` hangs in Bun — always use `parseBuffer()`
- **Healthcheck**: Docker image is Alpine without curl — use `wget`
- **Handlers return events, never call each other** — cascade via `EventType[]` return values, consumer enqueues them
- **data watcher ignores feed.xml/feed.opml writes** — otherwise infinite loop
- **Only entry.xml and \_entry.xml produce actionable events** from data watcher
- **M4B = single episode** — no chapter extraction, users must split beforehand
- **Supported audio**: .mp3 (audio/mpeg), .m4a (audio/mp4), .m4b (audio/mp4), .ogg (audio/ogg)
- **Episode ordering**: sort by `(disc, track, filename)` tuple from ID3, fallback to natural filename sort
- **Episode numbers persist** in entry.xml — stable across incremental updates, full renumber only on `/resync`

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

Docker healthcheck uses `wget` (NOT `curl` — not in alpine image):

```bash
wget -q --spider http://127.0.0.1/feed.opml
```
