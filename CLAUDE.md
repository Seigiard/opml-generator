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

## Testing

Run tests via Docker, not locally (integration tests need ImageMagick, ffmpeg).

```bash
bun run test       # unit + integration (in docker)
bun run test:e2e   # nginx + event logging (outside docker)
bun run test:all   # everything
bun --bun tsc --noEmit  # type check (locally is fine)
```

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

## Key Architectural Rules

- **/data mirrors /audiobooks**: audio file → folder with `entry.xml`; folder with episodes → `feed.xml` + `cover.jpg` + `_entry.xml`; root → `feed.opml`
- **Dual server**: nginx:80 (external, static files, auth) + Bun:3000 (internal, events, resync)
- **Event-driven via async/neverthrow**: adapters classify inotify events → SimpleQueue → consumer → handlers → cascade events
- **DI via AppContext + Pick<>**: `buildContext()` creates plain service objects; handlers receive `HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">` at compile time
- **Structured shutdown**: AbortController signals consumer + reconciliation to stop; `server.stop()` halts HTTP first
- **Resync is fire-and-forget**: returns 202, clears /data, re-runs initial sync
- **Flat JSON logging** to stdout — no file-based logging

See `ARCHITECTURE.md` for detailed event flows, handler reference, and diagrams.
