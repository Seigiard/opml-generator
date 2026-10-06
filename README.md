# OPML Generator

Podcast RSS and OPML feed generator for locally stored audiobooks and podcasts.

## Philosophy

**Your files, your structure.** This generator respects your existing file organization:

- Files are never modified, renamed, or moved
- No database or proprietary storage format
- Metadata is cached separately in `/data`, mirroring your file structure
- Delete, add, or reorganize files anytime — feeds update automatically
- Minimal dependencies, maximum simplicity

## Features

- Each folder with audio files becomes a podcast RSS 2.0 feed (with iTunes extensions)
- Root OPML file aggregates all podcast feeds
- ID3 metadata extraction (title, artist, album, track, duration, cover art)
- Folder-level cover art (embedded or standalone image files)
- Stable episode numbering across incremental updates
- HTTP Range request support for seeking/streaming
- File watching with automatic feed regeneration
- Full resync via authenticated `/resync` endpoint

## Supported Audio Formats

| Format | Extensions | MIME Type  | Notes                                   |
| ------ | ---------- | ---------- | --------------------------------------- |
| MP3    | .mp3       | audio/mpeg |                                         |
| M4A    | .m4a       | audio/mp4  |                                         |
| M4B    | .m4b       | audio/mp4  | Treated as single episode (no chapters) |
| OGG    | .ogg       | audio/ogg  |                                         |

## Quick Start with Docker

### Docker Compose (recommended)

1. Create `docker-compose.yml`:

```yaml
services:
  opml:
    image: ghcr.io/seigiard/opml-generator:latest
    init: true
    stop_grace_period: 15s
    ports:
      - "8080:80"
    volumes:
      - /path/to/your/audiobooks:/audiobooks:ro
      - opml-data:/data
    environment:
      # Optional: enable /resync endpoint with Basic Auth
      # - ADMIN_USER=admin
      # - ADMIN_TOKEN=your-secret-token
      # - RATE_LIMIT_MB=5
    restart: unless-stopped

volumes:
  opml-data:
```

2. Run:

```bash
docker compose up -d
```

3. Open http://localhost:8080/feed.opml — add individual podcast `feed.xml` URLs to your podcast app.

### Docker Run

```bash
docker run -d \
  --name opml \
  --init --stop-timeout=15 \
  -p 8080:80 \
  -v /path/to/your/audiobooks:/audiobooks:ro \
  -v opml-data:/data \
  ghcr.io/seigiard/opml-generator:latest
```

### Build from Source

```bash
git clone https://github.com/Seigiard/opml-generator.git
cd opml-generator
docker compose up -d --build
```

## Environment Variables

| Variable             | Default       | Description                                       |
| -------------------- | ------------- | ------------------------------------------------- |
| `FILES`              | `/audiobooks` | Path to your audiobooks directory                 |
| `DATA`               | `/data`       | Path for cache and metadata                       |
| `PORT`               | `3000`        | Internal Bun server port                          |
| `DEV_MODE`           | `false`       | Enable hot reload for Bun                         |
| `ADMIN_USER`         | -             | Username for /resync Basic Auth                   |
| `ADMIN_TOKEN`        | -             | Password for /resync Basic Auth                   |
| `RATE_LIMIT_MB`      | `0`           | Streaming rate limit in MB/s (0 = off)            |
| `RECONCILE_INTERVAL` | `1800`        | Periodic reconciliation seconds (0 = off, min 60) |

## API

| Endpoint                    | Description                                 |
| --------------------------- | ------------------------------------------- |
| `GET /`                     | Redirect to /feed.opml                      |
| `GET /feed.opml`            | Root OPML (aggregates all podcast feeds)    |
| `GET /data/{path}/feed.xml` | Individual podcast RSS feed                 |
| `GET /audiobooks/{path}`    | Stream audio file (supports Range requests) |
| `GET /static/*`             | Static assets                               |
| `POST /resync`              | Trigger full resync (requires Basic Auth)   |
| `GET /ready`                | Publication readiness (`200` or `503`)      |

`/resync` returns `202` when the rebuild is accepted. This response does not mean
that publication is complete. During initial sync, reconciliation, or another
resync, it returns `409` and does not defer the request. Resync waits for the
active handler before clearing generated data and rereading source metadata.
Source notifications remain accepted during the reset and rebuild. `/ready`
returns `503` after reset starts and `200` after successful publication. A failed
rebuild releases the pass so an authenticated retry can recover publication.

Returns 503 with `Retry-After: 5` if `feed.opml` doesn't exist yet (initial sync in progress).

## Shutdown and Restart

TERM and INT handling is active during startup, reconciliation, resync, and ordinary updates.
Shutdown closes event and resync admission immediately; the internal endpoints return `503`.
It stops new handlers and passes, and gives the active handler up to 8 seconds to finish.
Pending publication work is recovered on the next startup from the unchanged source files and remaining cache.
Keep the `/data` volume across restart.
Readiness stays `503` until that startup has repaired RSS and OPML successfully, even if an old OPML file survives.

Use the configured 15-second container stop timeout.
The entrypoint forwards signals and waits for its children within that budget.
An unexpected child failure produces a nonzero container exit.

## Directory Structure

```
/audiobooks/                    # Your audiobooks (mounted read-only)
├── Author/
│   └── Book Title/
│       ├── 01 - Chapter One.mp3
│       ├── 02 - Chapter Two.mp3
│       └── cover.jpg
└── Another Author/
    └── Podcast/
        ├── episode1.mp3
        └── episode2.ogg

/data/                          # Mirror cache (auto-generated)
├── feed.opml                   # Root OPML aggregation
├── Author/
│   ├── _entry.xml              # Folder entry for parent
│   └── Book Title/
│       ├── feed.xml            # Podcast RSS 2.0 feed
│       ├── cover.jpg           # Cover art (1400px max)
│       ├── _entry.xml          # Folder entry for parent
│       ├── 01 - Chapter One.mp3/
│       │   └── entry.xml       # Cached episode metadata
│       └── 02 - Chapter Two.mp3/
│           └── entry.xml
└── Another Author/
    └── Podcast/
        ├── feed.xml
        ├── episode1.mp3/
        │   └── entry.xml
        └── episode2.ogg/
            └── entry.xml
```

## Episode Ordering

Episodes are ordered using a `(disc, track, filename)` sort tuple:

1. **ID3 disc + track number** (primary) — from embedded metadata
2. **Natural sort by filename** (fallback) — when no ID3 tags present

The source files and folders are authoritative. RSS reflects the current library.
Episode numbers in RSS are assigned from 1 after sorting on every feed update.
Adding or removing files, renaming them, or changing disc and track tags can change these numbers.
The cached `episodeNumber` in `entry.xml` does not determine the number published in RSS.

## M4B Limitation

M4B files contain an entire audiobook with internal chapter markers. This generator treats each M4B as a single episode — chapter extraction is out of scope. Split M4B files beforehand using OpenAudible, ffmpeg, or mp4chaps.

## Development

```bash
# Start dev server with hot reload
docker compose -f docker-compose.dev.yml up

# Run tests (in Docker)
bun run test

# Run e2e tests
bun run test:e2e

# Lint + format
bun run fix
```

## License

MIT
