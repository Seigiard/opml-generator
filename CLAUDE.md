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
├── stopping.ts      # Filesystem mutation guards
├── cache-boundary.ts # Cache path containment and bounded parents
├── cache-layout.js  # Shared Bun/njs private `~` cache codec (+ cache-layout.d.ts)
├── cache-projection.ts # Typed interface to cache-layout.js
├── cache-mirrors.ts # Structural cache traversal through `~` containers
├── engine/          # Shared-engine synchronization composition and runtime
├── effect/          # Event handling (Effect Result + async/await)
│   ├── types.ts     # RawBooksEvent and EventType helpers
│   └── handlers/    # source-path-sync, audio-sync, folder-meta-sync, folder-cleanup, opml-sync, ...
├── audio/           # ID3 reader, cover finder
├── rss/             # Podcast RSS 2.0 (iTunes namespace), OPML 2.0
├── logging/         # Flat JSON logger to stdout, error schema
└── utils/           # Image processing (sharp)
ui/
├── app/             # Browser shell, feed parsers, routes, and DOM rendering
├── scripts/         # Deterministic Bun browser build
└── styles/          # Shell reset and styles
static/              # Committed shell artifacts served from /_app/
test/                # unit/, engine/, integration/ (needs Docker), e2e/, helpers/, fixtures/audio/
docs/adr/            # Architecture decisions
```

nginx on port 80 exposes the browser shell at `/` and `/browse/`, `/feed.opml`, source-relative public metadata paths, audio streaming, and `/ready`. Shell assets are under `/_app/`. It proxies `/resync` behind Basic Auth. Bun on port 3000 (localhost only) handles `GET /ready`, `POST /events/books`, and `POST /resync`.

`/data` is a generated cache with a reversible private projection of `/audiobooks`. Source files and folders are authoritative, and RSS reflects the current Library. An audio file maps to an episode mirror with `entry.xml`. A folder with episodes gets `feed.xml`, `cover.jpg`, and `_entry.xml`. The root gets `feed.opml`. Public metadata paths and Episode identity remain source-relative. The shared engine owns synchronization, freshness state, and the output lease under `DATA/~/.sync-engine`; that path is outside every supported cache projection.

<important if="you need to run commands to build, test, lint, start, or inspect the app">

Docker dev runs at http://localhost:8080. Run the app and unit/integration tests in Docker. The E2E runner tests production containers. Stop containers gracefully after tests.

Use `package.json` for scripts and `lefthook.yml` for pre-commit (staged files) and pre-push hooks. Rebuild Docker test images after dependency changes; the test compose file does not mount local dependencies. Local typechecking is allowed. The committed `static/` output is built from `ui/`. Commit it with the `ui/` change; the pre-commit hook rejects a commit whose staged `static/` is stale and names the fix.
The UI build must run on the Bun version in `.bun-version`. UI markup lives in `<template>` elements in `ui/app/index.html`; `ui/app/template.ts` clones them and fills `data-slot` nodes, and UI tests load the shell through `test/helpers/ui-document.ts`.

To run one test file in Docker:

```sh
docker compose -f docker-compose.test.yml run --rm test bun test test/unit/effect/handlers/audio-sync.test.ts
```

Keep the explicit print width in `.oxfmtrc.json` so tool-default changes do not alter repository formatting. Keep types with only local consumers private; Knip reports unused exported types.

For concurrent E2E worktrees, use a distinct `COMPOSE_PROJECT_NAME` and port. Set matching `TEST_PORT` and `TEST_BASE_URL`, for example `TEST_PORT=18086 TEST_BASE_URL=http://localhost:18086 bun run test:e2e`.

`bun run smoke:engine` is the manual production-boundary gate for the shared engine. It builds and runs the production image, checks first-start readiness, validates SIGTERM exit, and verifies restart replay. It is not part of `bun run test:e2e` or CI because it stops and restarts the production container and owns its compose project and volume.

</important>

<important if="you are finishing a task or about to commit">

1. Run `bun run test` and confirm 0 failures. Commit only after a green run. No git hook runs tests.
2. Let Lefthook run the other checks: pre-commit formats, lints, and typechecks staged files; pre-push runs Knip and the `static/` check against `HEAD`. When a hook fails, fix the cause and rerun it.
3. Update agent instructions only when the change alters a required action, project constraint, or non-obvious gotcha. Put detailed contracts in their referenced documents; keep versions, script inventories, and configuration defaults in their source files.

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

Read `docs/agents/synchronization.md`, especially "Passes and publication", before changing engine behavior. It holds the current contract. ADR `0001` records the filesystem-authoritative decision; its old lifecycle rules are superseded.

</important>

<important if="you are changing shutdown, bootstrap, the entrypoint, or process ownership">

Read "Shutdown and process ownership" in `docs/agents/synchronization.md` before changing signal handling, bootstrap, or child cleanup.

</important>

<important if="you are changing source-path reconciliation, source traversal, or cache mutation guards">

Read "Source reconciliation and cache safety" in `docs/agents/synchronization.md` before changing traversal or cache mutations.

</important>

<important if="you are changing cache layout, public metadata paths, or legacy cache upgrades">

Read `docs/adr/0002-unrestricted-source-names-private-cache.md` first for the projection and deployment constraint. Use the shared Bun/njs codec in `src/cache-layout.js` for physical paths and public metadata resolution; `src/cache-projection.ts` is its typed interface and `src/cache-mirrors.ts` traverses structural containers.

</important>

<important if="you are adding or modifying event handlers or engine work">

Read "Work adapters and handlers" in `docs/agents/synchronization.md` before adding event handlers or engine work.

</important>

<important if="you are changing watchers, data-watcher event handling, or debugging an infinite event loop">

Read "Source watcher" in `docs/agents/synchronization.md` before changing watcher transport or diagnosing event loops. There is no data watcher; generated-file changes do not post back to Bun.

</important>

<important if="you are reading audio metadata or changing ID3 extraction">

- `music-metadata` `parseFile()` hangs in Bun. Always use `parseBuffer()`.
- Use `src/types.ts` for supported audio extensions and MIME types.
- An M4B file is one episode. There is no chapter extraction; users split files beforehand.

</important>

<important if="you are changing RSS or OPML generation, episode ordering, or episode numbering">

Read "RSS and OPML" in `docs/agents/synchronization.md` before changing feed generation, ordering, or numbering.

</important>

<important if="you are writing or modifying tests, or tests are failing">

Use `test/helpers/` for shared mocks and assertions. Put pure logic tests in `test/unit/`, real engine/output cases in `test/engine/`, Linux watcher transport in `test/integration/`, and nginx publication/auth cases in `test/e2e/`.

Preserve failure status through graceful E2E cleanup in `tools/test-e2e.sh`; teardown failure must also fail an otherwise successful run.

</important>

<important if="you are adding or using environment variables or configuration">

Read `src/config.ts` for Bun settings and validation, `entrypoint.sh` for nginx/auth/streaming settings, and the selected compose file for container overrides. Bun fallback paths and Docker-mounted paths are different; use the settings for the environment being changed.

</important>

<important if="you are working on /resync or its authentication">

- `/resync` needs both `ADMIN_USER` and `ADMIN_TOKEN`. Without them, nginx drops the auth block.
- The `AUTH_ENABLED` logic lives in `entrypoint.sh`.

</important>

<important if="you are editing the Dockerfile, docker-compose files, or healthchecks">

The image is Alpine without `curl`. Healthchecks use nginx `GET /ready`, which reflects publication readiness: `wget -q --spider http://127.0.0.1/ready`. The image includes `util-linux` because the shared engine output lease uses Linux `flock`.

</important>

<important if="you are changing logging or how thrown errors are logged">

Read `src/logging/error-schema.ts` before changing thrown-error logging; decode thrown values at the logger boundary.

</important>

<important if="you are changing lint configuration, Oxlint versions, or the vendored anti-slop rules">

- Anti-slop rules are vendored from `dmmulroy/anti-slop` at `tools/oxlint/anti-slop/`. `UPSTREAM.md` records the source revision.
- `.oxlintrc.json` loads the anti-slop plugin, so `bun run lint` (CI and pre-commit) checks owned JS/TS, tests included. There is no separate anti-slop config.
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
