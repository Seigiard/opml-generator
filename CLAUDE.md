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
bun run lint:fix && bun run format
bun run test
npx knip  # check unused exports/deps
```

Update `CLAUDE.md` or `ARCHITECTURE.md` if architecture changed.

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

**IMPORTANT:** Run tests via docker, not locally!

```bash
# Run unit + integration tests (inside docker)
bun run test

# Run e2e tests (nginx + event logging, outside docker)
bun run test:e2e

# Run ALL tests (unit + integration + e2e)
bun run test:all

# Run specific test file
docker compose -f docker-compose.test.yml run --rm test bun test test/integration/effect/queue-consumer.test.ts

# Type check (locally is fine)
bun --bun tsc --noEmit
```

### Test Structure

```
test/
├── setup.ts             # Global test setup
├── helpers/             # Mock services, assertions, fs utils
├── unit/                # Pure logic, no external deps
│   ├── audio/           # ID3 reader, cover finder tests
│   ├── rss/             # RSS + OPML generator tests
│   ├── utils/           # Image processing tests
│   └── effect/handlers/ # Handler unit tests
├── integration/         # Requires docker (ImageMagick, ffmpeg)
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
├── audio/           # Audio metadata extraction
│   ├── types.ts     # AudioMetadata interface
│   ├── id3-reader.ts # music-metadata via parseBuffer() (NOT parseFile)
│   └── cover.ts     # Folder cover art finder
├── rss/             # Feed generation
│   ├── types.ts     # PodcastInfo, EpisodeInfo, OpmlOutline
│   ├── podcast-rss.ts # Podcast RSS 2.0 with iTunes namespace
│   └── opml.ts      # OPML 2.0 feed aggregation
├── effect/          # EffectTS event handling
│   ├── types.ts     # RawBooksEvent, RawDataEvent, EventType
│   ├── services.ts  # DI services
│   ├── consumer.ts  # Event loop
│   ├── adapters/    # Raw → typed event conversion
│   │   ├── books-adapter.ts    # /audiobooks watcher events
│   │   ├── data-adapter.ts     # /data watcher events
│   │   └── sync-plan-adapter.ts # Initial sync → events
│   └── handlers/    # audio-sync, folder-sync, opml-sync, etc.
├── logging/         # Structured logging
│   ├── types.ts     # LogLevel, LogContext
│   └── index.ts     # Flat JSON logger to stdout
└── utils/           # image, processor
```

## Architecture: Dual Server

```
nginx:80 (external)              Bun:3000 (localhost only)
├── / → /feed.opml               ├── POST /events/books ← audiobooks watcher
├── /audiobooks/* → static       ├── POST /events/data ← data watcher
├── /static/* → /app/static      └── POST /resync ← nginx
├── /resync → auth → proxy
└── /* → /data/*
```

## Architecture: EffectTS Layers

1. **Adapters** (`adapters/*.ts`) — raw inotify → typed EventType
2. **Queue** (`EventQueueService`) — typed events only
3. **Consumer** (`consumer.ts`) — gets handler via `HandlerRegistry.get()`
4. **Handlers** (`handlers/*.ts`) — return `EventType[]` for cascades

### Cascade Chain

```
AudioFileCreated (audiobooks watcher → books-adapter)
  → audio-sync: read ID3, write entry.xml + folder-level cover.jpg → returns []

  (data watcher detects entry.xml close_write)
  → EntryXmlChanged (data-adapter)
    → parentMetaSync → returns [FolderMetaSyncRequested]
      → folder-meta-sync: read entry.xml files → write feed.xml + _entry.xml
        → returns [FeedXmlCreated] if feed.xml is new
        → returns [FeedXmlDeleted] if last episode removed
        → returns [] if content update only

  FeedXmlCreated (from folder-meta-sync cascade return)
    → opml-sync: collect feed.xml paths → write feed.opml → returns []
```

### DI Services

| Service                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `ConfigService`        | filesPath, dataPath, baseUrl, port     |
| `LoggerService`        | info, warn, error, debug (JSON stdout) |
| `FileSystemService`    | mkdir, rm, readdir, stat, atomicWrite  |
| `DeduplicationService` | TTL-based (500ms) event filtering      |
| `EventQueueService`    | enqueue, enqueueMany, size, take       |
| `HandlerRegistry`      | Map<tag, handler>                      |

### Key Patterns

**Cascade events** — handlers return events, don't call each other:

```typescript
return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }];
```

**Flag cleanup** — use `Effect.ensuring`:

```typescript
Effect.gen(function* () {
  isSyncing = true;
  yield* doWork;
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      isSyncing = false;
    }),
  ),
);
```

**ManagedRuntime** — share single Layer instance across all Effect calls:

```typescript
// ✅ Correct: single runtime, shared queue
const runtime = ManagedRuntime.make(LiveLayer);
await runtime.runPromise(effect1);
await runtime.runPromise(effect2); // same queue instance

// ❌ Wrong: each provide creates NEW queue instance
await Effect.runPromise(Effect.provide(effect1, LiveLayer));
await Effect.runPromise(Effect.provide(effect2, LiveLayer)); // different queue!
```

**Mirror structure** — /data mirrors /audiobooks:

- Audio file → folder with `entry.xml` (cached episode metadata)
- Folder with episodes → `feed.xml` (podcast RSS) + `cover.jpg` + `_entry.xml` (for parent)
- Root → `feed.opml` (OPML aggregation)

## Supported Audio Formats

| Format | Extensions | MIME Type  | Notes                                   |
| ------ | ---------- | ---------- | --------------------------------------- |
| MP3    | .mp3       | audio/mpeg |                                         |
| M4A    | .m4a       | audio/mp4  |                                         |
| M4B    | .m4b       | audio/mp4  | Treated as single episode (no chapters) |
| OGG    | .ogg       | audio/ogg  |                                         |

### M4B Limitation

M4B files contain an entire audiobook with internal chapter markers. This generator treats each M4B as a single episode — chapter extraction is out of scope. Split M4B files beforehand using OpenAudible, ffmpeg, or mp4chaps.

## Podcast RSS Generation

Each folder with audio files produces a `feed.xml` (podcast RSS 2.0):

```xml
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Album Name</title>
    <itunes:author>Artist</itunes:author>
    <itunes:type>serial</itunes:type>
    <item>
      <title>Chapter 1</title>
      <enclosure url="https://host/audiobooks/Author/Book/01.mp3"
                 length="12345678" type="audio/mpeg"/>
      <itunes:episode>1</itunes:episode>
    </item>
  </channel>
</rss>
```

### Episode Ordering

- Primary: ID3 disc + track number → sort by `(disc, track, filename)` tuple
- Fallback: natural sort by filename
- Episode numbers persisted in `entry.xml` — stable across incremental updates
- Full renumber only on explicit `/resync`

## music-metadata + Bun

`parseFile()` hangs in Bun. Always use `parseBuffer()`:

```typescript
import { parseBuffer } from "music-metadata";
const buf = new Uint8Array(await Bun.file(filePath).arrayBuffer());
const metadata = await parseBuffer(buf, { path: filePath });
```

## Troubleshooting

### Queue Not Processing Events

Check ManagedRuntime usage — each `Effect.provide()` creates NEW queue instance.
Always use shared runtime: `const runtime = ManagedRuntime.make(LiveLayer)`

### Infinite Loop in Watchers

- data watcher excludes `.jsonl` files
- feed.xml and feed.opml writes are classified as `Ignored` by data adapter
- Only `entry.xml` and `_entry.xml` produce actionable events
- Check watcher.sh exclusion patterns

### Tests Failing

- Always run tests in Docker: `bun run test`
- Integration tests require ImageMagick, ffmpeg
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
