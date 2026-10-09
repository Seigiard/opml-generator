# CLAUDE.md

Podcast RSS + OPML feed generator for locally stored audiobooks, built on Bun, nginx, and Docker. It watches `/audiobooks`, extracts ID3 metadata, and writes a per-folder `feed.xml` (podcast RSS 2.0) and a root `feed.opml` that any podcast app can subscribe to.

## Project map

```
src/
├── server.ts        # Bootstrap, HTTP server, signal handling
├── config.ts        # Environment configuration
├── constants.ts     # File names (feed.xml, entry.xml, feed.opml, ...)
├── types.ts         # MIME_TYPES, AUDIO_EXTENSIONS
├── watcher.sh       # Owned inotify process groups → NUL-delimited events
├── watcher-events.ts # Bun stdin framing + JSON serialization → POST /events
├── context.ts       # AppContext, HandlerDeps, buildContext()
├── stopping.ts      # Filesystem guards with shared publication-lock identity
├── cache-boundary.ts # Cache path containment and bounded parents
├── cache-layout.js  # Shared Bun/njs private `~` cache codec (+ cache-layout.d.ts)
├── cache-projection.ts # Typed interface to cache-layout.js
├── cache-mirrors.ts # Structural cache traversal through `~` containers
├── engine/          # Shared-engine synchronization composition and runtime
├── effect/          # Event handling (neverthrow + async/await)
│   ├── types.ts     # RawBooksEvent and EventType helpers
│   └── handlers/    # source-path-sync, audio-sync, folder-meta-sync, folder-cleanup, opml-sync, ...
├── audio/           # ID3 reader, cover finder
├── rss/             # Podcast RSS 2.0 (iTunes namespace), OPML 2.0
├── logging/         # Flat JSON logger to stdout, error schema
└── utils/           # Image processing (sharp)
test/                # unit/, engine/, integration/ (needs Docker), e2e/, helpers/, fixtures/audio/
docs/adr/            # Architecture decisions
```

nginx on port 80 exposes `/feed.opml`, source-relative public metadata paths, audio streaming, and `/ready`. It proxies `/resync` behind Basic Auth. Bun on port 3000 (localhost only) handles `GET /ready`, `POST /events/books`, and `POST /resync`.

`/data` is a generated cache with a reversible private projection of `/audiobooks`. Source files and folders are authoritative, and RSS reflects the current Library. An audio file maps to an episode mirror with `entry.xml`. A folder with episodes gets `feed.xml`, `cover.jpg`, and `_entry.xml`. The root gets `feed.opml`. Public metadata paths and Episode identity remain source-relative. The shared engine owns synchronization, freshness state, and the output lease under `DATA/~/.sync-engine`; that path is outside every supported cache projection.

<important if="you need to run commands to build, test, lint, start, or inspect the app">

Docker dev runs at http://localhost:8080. Run the app and unit/integration tests in Docker. The E2E runner tests production containers. Stop containers gracefully after tests.

| Command                                                                                                         | What it does                                    |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `docker compose -f docker-compose.dev.yml up`                                                                   | Start dev server (hot reload)                   |
| `docker compose -f docker-compose.dev.yml logs -f`                                                              | Follow dev logs                                 |
| `curl http://localhost:8080/feed.opml`                                                                          | Check OPML                                      |
| `curl http://localhost:8080/Author/Book/feed.xml`                                                               | Check a podcast RSS feed                        |
| `curl -u admin:secret 'http://localhost:8080/resync?force=1'`                                                   | Force resync                                    |
| `bun run fix`                                                                                                   | format:fix + lint:fix                           |
| `bun run lint:anti-slop`                                                                                        | Anti-slop Oxlint rules (separate CI job)        |
| `bun run test`                                                                                                  | Unit + integration tests in Docker              |
| `docker compose -f docker-compose.test.yml run --rm test bun test test/unit/effect/handlers/audio-sync.test.ts` | Run one test file in Docker                     |
| `bun run test:e2e`                                                                                              | Production container E2E tests                  |
| `bun run smoke:engine`                                                                                          | Manual production-boundary engine smoke         |
| `bun run test:all`                                                                                              | All tests                                       |
| `bun run rebuild:test`                                                                                          | Rebuild the test image after dependency changes |
| `bun --bun tsc --noEmit`                                                                                        | Type check (local run is fine)                  |
| `npx knip`                                                                                                      | Find unused exports and dependencies            |

Other scripts live in `package.json`.

For concurrent E2E worktrees, use a distinct `COMPOSE_PROJECT_NAME` and port. Set matching `TEST_PORT` and `TEST_BASE_URL`, for example `TEST_PORT=18086 TEST_BASE_URL=http://localhost:18086 bun run test:e2e`.

`bun run smoke:engine` is the manual production-boundary gate for the shared engine. It builds and runs the production image, checks first-start readiness, validates SIGTERM exit, and verifies restart replay. It is not part of `bun run test:e2e` or CI because it stops and restarts the production container and owns its compose project and volume.

</important>

<important if="you are finishing a task or about to commit">

1. Run `bun run fix`. The policy is zero warnings and zero errors.
2. Run `bun run test` and confirm 0 failures. Commit only after a green run.
3. Run `npx knip` and resolve every new finding.
4. Update this file when the change affects architecture, dependencies, commands, gotchas, or project structure.

</important>

<important if="you are writing code, scripts, or commands that use a runtime, package manager, test runner, HTTP server, file I/O, shell calls, or hashing">

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

</important>

<important if="you are changing synchronization passes, the reconcile loop, resync, or the engine lifecycle">

Read `docs/adr/0001-filesystem-authoritative-synchronization.md` first. It points to the current shared-engine publication and recovery contract.

- `startEpisodeEngineRuntime()` owns initial sync, reconciliation, source notifications, resync, readiness, and shutdown.
- The shared engine plans current source audio, writes episode mirrors, folds folder RSS work, then writes final OPML after covered RSS work completes.
- Freshness uses source metadata and generated output paths. A forced pass from `/resync?force=1` reprocesses work even when descriptors are unchanged. Watcher changed-path hints also reprocess the hinted work.
- nginx `GET /ready` proxies engine availability. It returns `200` only after `feed.opml` is available; otherwise it returns `503` with status JSON.
- `/resync` returns `202` when the engine accepts or queues a freshness-gated pass. During shutdown, HTTP closes before engine stop completes, so nginx can return a connection or proxy error. Use `/resync?force=1` to force reprocessing.
- `RECONCILE_INTERVAL=0` disables periodic reconciliation.

</important>

<important if="you are changing shutdown, bootstrap, the entrypoint, or process ownership">

- `runServer()` installs TERM and INT handling before awaiting context setup or starting initial sync. The engine runtime owns active work and reconciliation.
- Shutdown closes HTTP first, awaits the engine runtime stop hook, then exits.
- Guarded filesystem services preserve the original OPML lock identity.
- The shell entrypoint forwards signals promptly and waits for Bun, nginx, and the watcher. Unexpected child exits fail the container. Watcher pipelines own process groups so inotify and in-flight wget receive TERM together.
- Compose uses an init reaper and a 15-second stop grace period. The entrypoint watchdog is the shutdown upper bound for the engine and helper cleanup.
- The disposable shell watchdog owns its sleep process group. Entrypoint verifies group creation before cancellation so a fast child exit cannot leave an uncancelled 11-second timer.

</important>

<important if="you are changing source-path reconciliation, source traversal, or cache mutation guards">

- Source watcher hints call `notifyBooksEvent()` on the engine runtime. Work checks current filesystem state and reconciles descendants.
- Audio metadata writes directly trigger folder RSS; folder RSS triggers parent navigation and OPML, including changes to existing podcast information. Prune empty cache branches only when their source subtree has no supported audio.
- Source type changes remove the obsolete mirror before rebuilding. Episode mirrors retain only `entry.xml`; folder mirrors remove that episode marker. A metadata request for a path now occupied by supported audio reconciles the file. Unsupported regular files remove obsolete mirrors and cannot become episodes. See `src/effect/handlers/mirror-kind.ts`.
- `src/effect/handlers/source-kind.ts` checks each source component with `fs.lstat()`. Only regular directories and supported regular audio enter the Catalog. Symlinks, broken links, cycles, and paths beneath symlink ancestors are excluded; watcher hints and recovery remove obsolete mirrors. Creation handlers recheck source kind after scanning. Source access errors fail owned work; cache traversal and OPML keep `fs.stat()` semantics.
- The source root must remain a regular directory. The engine checks it during source scans and before OPML publication. A missing or excluded root fails the pass and retains prior OPML; it never becomes a root deletion hint.
- `src/cache-boundary.ts` owns containment and bounded parents. Cache handlers validate entry paths. Mutation guards reject cache-root removal, out-of-root paths, and symlink ancestors. Atomic writes also check temporary paths. Cover encoding completes before guarded directory/write operations.

</important>

<important if="you are changing cache layout, public metadata paths, or legacy cache upgrades">

Read `docs/adr/0002-unrestricted-source-names-private-cache.md` first. It records unrestricted source names and the private cache projection.

- `src/cache-layout.js` is the shared Bun/njs codec. `cache-projection.ts` provides its typed interface; `cache-mirrors.ts` traverses structural containers. Public metadata URI resolution uses the same codec.
- Service names (`feed.xml`, `feed.opml`, `entry.xml`, `_entry.xml`, `cover.jpg`, log names), `.tmp` names, and literal `~` segments use a private `~` container. Other segments keep their existing layout. Each original segment stays unchanged below its container, preserving filesystem length limits.
- Source `Author/feed.xml` maps to `/data/Author/~/feed.xml`, while public RSS stays `/Author/feed.xml/feed.xml`. Literal source `~` maps to `~/~`; prefix-looking names such as `~feed.xml` remain ordinary. Audio URLs and Episode GUID/filePath remain source-relative.
- The legacy cache-layout migration was deliberately removed with the old lifecycle. Deployments must already use the canonical `~` layout. Old legacy or mixed cache directories are not journaled or migrated.

</important>

<important if="you are adding or modifying event handlers or engine work">

Flow: source hints and engine plans → typed `EventType` work → handlers → generated outputs.

- Engine work adapters in `src/engine/composition.ts` call handlers and keep handler code independent. `src/engine/work.ts` defines work classes and keys.
- Handlers get `HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">`. The filesystem service includes `lstat` and atomic writes. See `src/context.ts`.
- Zod decodes watcher HTTP payloads at the input boundary. Handlers accept typed events only.

</important>

<important if="you are changing watchers, data-watcher event handling, or debugging an infinite event loop">

- There is no data watcher. Generated-file changes do not post back to Bun.
- Folder and OPML follow-up work comes from handler cascades inside `src/engine/composition.ts`.
- The source watcher must observe directories such as `events.jsonl`, including moves out of the Library. Source inotify uses `--no-dereference`.
- Fields are NUL-delimited. `watcher-events.ts` decodes parent/name/events and uses `JSON.stringify()` before invoking `wget -T 2`. Quotes, backslashes, and embedded newlines must remain valid fields. The serializer and wget inherit their worker's process group.
- Inotify formatting has a 4096-byte limit. The serializer validates frames; a damaged frame fails the owned worker group so later events cannot silently desynchronize.
- Select `Q_OVERFLOW` and route the books token to `/resync`; inotify does not emit `IN_Q_OVERFLOW`.

</important>

<important if="you are reading audio metadata or changing ID3 extraction">

- `music-metadata` `parseFile()` hangs in Bun. Always use `parseBuffer()`.
- Supported audio: `.mp3` (audio/mpeg), `.m4a` (audio/mp4), `.m4b` (audio/mp4), `.ogg` (audio/ogg).
- An M4B file is one episode. There is no chapter extraction; users split files beforehand.

</important>

<important if="you are changing RSS or OPML generation, episode ordering, or episode numbering">

- Zod decodes RSS metadata at its input boundary.
- Sort episodes by the `(disc, track, filename)` tuple from ID3. Fall back to a natural filename sort.
- RSS episode numbers start at 1 after sorting, on every feed update. Ignore the cached `episodeNumber` in `entry.xml`.
- OPML collection propagates directory, stat, read, and podcast XML errors. Failure retains prior OPML and fails the pass. Missing paths and valid navigation feeds are normally excluded.
- Root-level audio publishes `/feed.xml`. Build feed and cover URLs from joined relative paths so an empty root path does not add a second slash.
- Engine freshness checks source metadata descriptors and generated outputs before reusing prior work.
- Every pass verifies the audio-derived folder hierarchy and RSS. Changed-path hints, forced passes, or processing-version bumps reprocess affected work.

</important>

<important if="you are writing or modifying tests, or tests are failing">

- Unit tests (`test/unit/`) cover pure logic with mocked deps. Engine tests (`test/engine/`) cover engine passes, cache layout/boundaries, and real output behavior. Mocks and assertions are in `test/helpers/`.
- Integration tests (`test/integration/`) cover watcher transport with real Linux tools.
- E2E covers nginx publication and resync auth against production containers.
- `bun run test:e2e` uses `tools/test-e2e.sh`. It preserves compose-start and test failures through graceful cleanup; teardown failure also fails an otherwise successful run.

</important>

<important if="you are adding or using environment variables or configuration">

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

</important>

<important if="you are working on /resync or its authentication">

- `/resync` needs both `ADMIN_USER` and `ADMIN_TOKEN`. Without them, nginx drops the auth block.
- The `AUTH_ENABLED` logic lives in `entrypoint.sh`.

</important>

<important if="you are editing the Dockerfile, docker-compose files, or healthchecks">

The image is Alpine without `curl`. Healthchecks use nginx `GET /ready`, which reflects publication readiness: `wget -q --spider http://127.0.0.1/ready`. The image includes `util-linux` because the shared engine output lease uses Linux `flock`.

</important>

<important if="you are changing logging or how thrown errors are logged">

The logger decodes thrown values in `src/logging/error-schema.ts`. It keeps string messages, Error stacks, and JSON object messages.

</important>

<important if="you are changing lint configuration, Oxlint versions, or the vendored anti-slop rules">

- Anti-slop rules are vendored from `dmmulroy/anti-slop` at `tools/oxlint/anti-slop/`. `UPSTREAM.md` records the source revision.
- `bun run lint:anti-slop` checks owned JS/TS, tests included.
- Pin Oxlint and `@oxlint/plugins` together. `oxlint-tsgolint` must match Oxlint's peer requirement.

</important>

<important if="you are reading or publishing GitHub issues for Seigiard/opml-generator">

Read `docs/agents/issue-tracker.md` first.

</important>

<important if="you are applying triage labels">

Use the five default triage labels. Read `docs/agents/triage-labels.md` first.

</important>

<important if="you are exploring domain concepts, naming things, or making a design decision">

The repo uses a single-context layout: root `GLOSSARY.md` and `docs/adr/`. Read `docs/agents/domain.md` first.

</important>
