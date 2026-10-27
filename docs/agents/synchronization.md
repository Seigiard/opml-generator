# Synchronization contract

This document holds the current runtime rules for the shared-engine integration.
[ADR 0001](../adr/0001-filesystem-authoritative-synchronization.md) records the
filesystem-authoritative decision and superseded lifecycle rules, not the current
runtime contract. Use `GLOSSARY.md` at the repository root for domain terms.

## Passes and publication

- `startEpisodeEngineRuntime()` in `src/engine/runtime.ts` owns initial sync,
  reconciliation, source notifications, resync, readiness, and shutdown.
- The shared engine plans current source audio, writes episode mirrors, folds
  folder RSS work, then publishes final OPML after the covered RSS work completes.
- Freshness checks source metadata descriptors and generated output paths before
  reusing prior work. Changed-path hints, forced passes, and processing-version
  bumps reprocess affected work.
- Every pass verifies the audio-derived folder hierarchy and RSS.
- nginx `GET /ready` proxies engine availability. It returns `200` only after
  `feed.opml` is available; otherwise it returns `503` with status JSON.
- `/resync` returns `202` when the engine accepts or queues a freshness-gated pass.
  Use `/resync?force=1` to reprocess work even when descriptors are unchanged.
  During shutdown, HTTP closes before engine stop completes, so nginx can return
  a connection or proxy error.
- `RECONCILE_INTERVAL=0` disables periodic reconciliation.

## Source reconciliation and cache safety

- Source watcher hints call `notifyBooksEvent()` on the engine runtime. Work
  checks current filesystem state and reconciles descendants.
- Audio metadata writes trigger folder RSS; folder RSS triggers parent
  navigation. OPML follows from final publication at the end of each pass.
- Prune empty cache branches only when their source subtree has no supported
  audio.
- `src/effect/handlers/mirror-kind.ts` removes an obsolete mirror before rebuilding
  after a source type change. Episode mirrors retain only `entry.xml`; folder
  mirrors remove that marker. A metadata request for a path now occupied by
  supported audio reconciles the file. Unsupported regular files remove obsolete
  mirrors and cannot become episodes.
- `src/effect/handlers/source-kind.ts` checks each source component with
  `fs.lstat()`. Only regular directories and supported regular audio enter the
  Catalog. Symlinks, broken links, cycles, and paths beneath symlink ancestors are
  excluded; watcher hints and recovery remove obsolete mirrors.
- Creation handlers recheck source kind after scanning. Source access errors fail
  owned work; cache traversal and OPML keep `fs.stat()` semantics.
- The source root must remain a regular directory. The engine checks it during
  source scans and before OPML publication. A missing or excluded root fails the
  pass and retains prior OPML; it never becomes a root deletion hint.
- `src/cache-boundary.ts` owns containment and bounded parents. Cache handlers
  validate entry paths. Mutation guards reject cache-root removal, out-of-root
  paths, and symlink ancestors. Atomic writes also check temporary paths. Cover
  encoding completes before guarded directory/write operations.
- For private cache projection and deployment constraints, read
  [ADR 0002](../adr/0002-unrestricted-source-names-private-cache.md). Physical cache
  paths do not change public metadata paths or Episode identity.

## Work adapters and handlers

Flow: source hints and engine plans → typed `EventType` work → handlers → generated
outputs.

- Adapters in `src/engine/composition.ts` call handlers and keep handler code
  independent. `src/engine/work.ts` defines work classes and keys.
- Handlers get `HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">` from
  `src/context.ts`. The filesystem service includes `lstat` and atomic writes.
- Effect Schema decodes watcher HTTP payloads at the input boundary. Handlers accept typed
  events only.

## Source watcher

- Folder follow-up work comes from handler cascades inside
  `src/engine/composition.ts`; OPML follows from final publication.
- The source watcher must observe directories such as `events.jsonl`, including
  moves out of the Library. Source inotify uses `--no-dereference`.
- Fields are NUL-delimited. `src/watcher-events.ts` decodes parent/name/events and
  uses `JSON.stringify()` before invoking `wget -T 2`. Quotes, backslashes, and
  embedded newlines must remain valid fields.
- The serializer and wget inherit their worker's process group.
- Inotify formatting has a 4096-byte limit. The serializer validates frames; a
  damaged frame fails the owned worker group so later events cannot silently
  desynchronize.
- Select `Q_OVERFLOW` and route the books token to `/resync?force=1`; inotify does
  not emit `IN_Q_OVERFLOW`.

## RSS and OPML

- Effect Schema decodes RSS metadata at its input boundary.
- Sort episodes by the `(disc, track, filename)` tuple from ID3. Fall back to a
  natural filename sort.
- RSS episode numbers start at 1 after sorting, on every feed update. Ignore the
  cached `episodeNumber` in `entry.xml`.
- OPML collection propagates directory, stat, read, and podcast XML errors.
  Failure retains prior OPML and fails the pass. Missing paths and valid
  navigation feeds are normally excluded.
- Root-level audio publishes `/feed.xml`. Build feed and cover URLs from joined
  relative paths so an empty root path does not add a second slash.
- Navigation feed items carry `<kind>podcast|navigation</kind>`; the browser shell
  uses it to decide which entries get subscribe controls.

## Shutdown and process ownership

- `runServer()` installs TERM and INT handling before awaiting context setup or
  starting initial sync. The engine runtime owns active work and reconciliation.
- Shutdown closes HTTP first, awaits the engine runtime stop hook, then exits.
- `entrypoint.sh` forwards signals promptly and waits for Bun, nginx, and the
  watcher. Unexpected child exits fail the container.
- Watcher pipelines own process groups so inotify and in-flight wget receive TERM
  together.
- Compose uses an init reaper and a 15-second stop grace period. The entrypoint
  watchdog is the shutdown upper bound for engine and helper cleanup.
- The disposable shell watchdog owns its sleep process group. Entrypoint verifies
  group creation before cancellation so a fast child exit cannot leave an
  uncancelled 11-second timer.
