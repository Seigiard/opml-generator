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

Update `PLAN.md`, `CLAUDE.md`, or `@ARCHITECTURE.md` if architecture changed.

## Development Workflow

Docker dev runs at http://localhost:8080 — do NOT run bun locally.
Gracefully shutdown after tests.

```bash
docker compose -f docker-compose.dev.yml up          # start
docker compose -f docker-compose.dev.yml logs -f     # logs
curl http://localhost:8080/feed.xml                  # test
curl -u admin:secret http://localhost:8080/resync    # force resync
```

## Environment Variables

| Variable             | Default  | Description                                       |
| -------------------- | -------- | ------------------------------------------------- |
| `FILES`              | `/books` | Source books directory                            |
| `DATA`               | `/data`  | Generated metadata cache                          |
| `PORT`               | `3000`   | Internal Bun server port                          |
| `LOG_LEVEL`          | `info`   | debug \| info \| warn \| error                    |
| `DEV_MODE`           | `false`  | Enable Bun --watch hot reload                     |
| `ADMIN_USER`         | -        | /resync Basic Auth username                       |
| `ADMIN_TOKEN`        | -        | /resync Basic Auth password                       |
| `RATE_LIMIT_MB`      | `0`      | Download rate limit MB/s (0 = off)                |
| `RECONCILE_INTERVAL` | `1800`   | Periodic reconciliation seconds (0 = off, min 60) |

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
│   ├── utils/
│   └── effect/handlers/
├── integration/         # Requires docker (ImageMagick, poppler, etc.)
│   ├── formats/         # Format handler tests
│   └── effect/          # Queue + cascade flow tests
└── e2e/                 # Full system tests
    ├── nginx.test.ts    # nginx routing + auth
    └── event-logging.test.ts  # Event lifecycle tracing
```

## Project Structure

```
src/
├── server.ts        # HTTP server + initial sync + DI setup
├── config.ts        # Environment configuration
├── constants.ts     # File constants (feed.xml, entry.xml, etc.)
├── scanner.ts       # File scanning, sync planning
├── types.ts         # Shared types (MIME_TYPES, BOOK_EXTENSIONS)
├── watcher.sh       # inotifywait → POST /events
├── effect/          # EffectTS event handling
│   ├── types.ts     # RawBooksEvent, RawDataEvent, EventType
│   ├── services.ts  # DI services
│   ├── consumer.ts  # Event loop
│   ├── adapters/    # Raw → typed event conversion
│   │   ├── books-adapter.ts    # /books watcher events
│   │   ├── data-adapter.ts     # /data watcher events
│   │   └── sync-plan-adapter.ts # Initial sync → events
│   └── handlers/    # book-sync, folder-sync, etc.
├── formats/         # FormatHandler implementations
│   ├── types.ts     # FormatHandler, BookMetadata
│   ├── index.ts     # Handler registry
│   ├── utils.ts     # XML parsing utilities
│   └── *.ts         # epub, fb2, mobi, pdf, comic, txt, djvu
├── logging/         # Structured logging
│   ├── types.ts     # LogLevel, LogContext
│   ├── logger.ts    # Flat JSON logger to stdout
│   └── index.ts     # Exports
└── utils/           # archive, image, process, processor, opds
```

## Architecture: Dual Server

```
nginx:80 (external)          Bun:3000 (localhost only)
├── /opds → /feed.xml        ├── POST /events/books ← books watcher
├── /static/* → /app/static  ├── POST /events/data ← data watcher
├── /resync → auth → proxy   └── POST /resync ← nginx
└── /* → /data/*
```

## Architecture: EffectTS Layers

1. **Adapters** (`adapters/*.ts`) — raw inotify → typed EventType
2. **Queue** (`EventQueueService`) — typed events only
3. **Consumer** (`consumer.ts`) — gets handler via `HandlerRegistry.get()`
4. **Handlers** (`handlers/*.ts`) — return `EventType[]` for cascades

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

**Mirror structure** — /data mirrors /books:

- Book → folder with `entry.xml`, `cover.jpg`, `thumb.jpg`, `file` (symlink)
- Folder → `feed.xml` + `_entry.xml` (for parent)

## Adding New Format Handler

1. Create `src/formats/{format}.ts` implementing FormatHandler interface
2. Export `registration: FormatHandlerRegistration`
3. Import and add to registrations array in `src/formats/index.ts`

### Handler Interface

```typescript
interface FormatHandler {
  getMetadata(): BookMetadata;       // Sync extraction
  getCover(): Promise<Buffer | null>; // Async cover extraction
}

interface FormatHandlerRegistration {
  extensions: string[];               // ["epub", "epub3"]
  create: FormatHandlerFactory;       // async factory function
}
```

### Supported Formats

| Format | Extensions         | Dependencies      |
| ------ | ------------------ | ----------------- |
| EPUB   | .epub              | unzip             |
| FB2    | .fb2, .fbz         | unzip (fbz)       |
| MOBI   | .mobi, .azw, .azw3 | -                 |
| PDF    | .pdf               | poppler-utils     |
| DJVU   | .djvu              | djvulibre         |
| Comics | .cbz, .cbr, .cb7   | node-7z, unrar-js |
| Text   | .txt               | -                 |

## opds-ts Usage

```typescript
import { Entry, Feed } from "opds-ts/v1.2";

const entry = new Entry(id, title)
  .setAuthor(author)
  .addImage(coverUrl)
  .addAcquisition(downloadUrl, mimeType, "open-access");

const feed = new Feed(id, title).setKind("navigation").addSelfLink(href, "navigation");
```

## Troubleshooting

### Queue Not Processing Events

Check ManagedRuntime usage — each `Effect.provide()` creates NEW queue instance.
Always use shared runtime: `const runtime = ManagedRuntime.make(LiveLayer)`

### Infinite Loop in Watchers

- data watcher excludes `.jsonl` files
- feed.xml is NOT watched (only entry.xml and \_entry.xml)
- Check watcher.sh exclusion patterns

### Tests Failing

- Always run tests in Docker: `bun run test`
- Integration tests require ImageMagick, poppler-utils, djvulibre
- Check test fixtures exist in test/fixtures/

### Resync Not Working

- Requires ADMIN_USER + ADMIN_TOKEN environment variables
- nginx removes auth block if not configured
- Check entrypoint.sh AUTH_ENABLED logic

### Healthcheck Commands

Docker healthcheck uses `wget` (NOT `curl` — not in alpine image):

```bash
wget -q --spider http://127.0.0.1/feed.xml
```
