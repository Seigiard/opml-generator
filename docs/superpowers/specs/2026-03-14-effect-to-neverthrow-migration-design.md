# EffectTS → neverthrow + vanilla TS Migration (opml-generator)

## Problem

RSS grows linearly during event processing due to Bun's mimalloc allocator retaining freed pages. Same root cause as opds-generator (oven-sh/bun#21560).

Effect Queue's `Queue.take()` creates `Deferred` + `LinkedListNode` per call. GC collects them (heap stable), but mimalloc retains the freed pages despite `MIMALLOC_PURGE_DELAY=0`.

### Motivation

1. **Memory**: eliminate mimalloc page retention from Effect Queue internals
2. **Alignment**: opds-generator already migrated — maintain identical architecture across both projects
3. **Dependency reduction**: removes ~2.5 MB of `effect` + `@effect/schema` from node_modules
4. **Simplicity**: handlers use `Effect.gen` + `yield*` wrapping what is fundamentally async/await code
5. **Testability**: plain async functions with mock objects vs Effect layers

## Reference

opds-generator migration spec: `/Users/seigiard/Projects/opds-generator/docs/superpowers/specs/2026-03-14-effect-to-neverthrow-migration-design.md`

opds-generator migrated code (production, battle-tested):
- `src/context.ts` — AppContext + HandlerDeps + buildContext()
- `src/queue.ts` — SimpleQueue + UnrolledQueue + QueueChunk

## Goal

Replace EffectTS with:
- **neverthrow** for type-safe error handling (`Result<T,E>`)
- **Plain `AppContext` + `Pick<>`** for compile-time DI
- **SimpleQueue** (vanilla TS) for event queue
- **AbortController** for structured shutdown (replaces Fiber)

Eliminate both `effect` and `@effect/schema` dependencies entirely.

## Scope

| Area | Files | ~Lines |
|---|---|---|
| src/effect/ + server.ts | 15 | ~1,674 |
| Existing tests (rewrite) | 10 | ~2,147 |
| **New tests (write)** | **~5** | **~400** |
| **Total** | **~30** | **~4,221** |

### Existing Test Files

**10 Effect-dependent test files** (~2,147 lines) must be rewritten:

| Test File | Lines | Action |
|---|---|---|
| `test/unit/effect/handlers/parent-meta-sync.test.ts` | 96 | REWRITE (Effect layers → mock deps) |
| `test/unit/effect/handlers/folder-entry-xml-changed.test.ts` | 121 | REWRITE |
| `test/unit/effect/handlers/audio-sync.test.ts` | 238 | REWRITE |
| `test/unit/effect/handlers/opml-sync.test.ts` | 242 | REWRITE |
| `test/unit/effect/handlers/folder-meta-sync.test.ts` | 440 | REWRITE |
| `test/unit/effect/events.test.ts` | 299 | REWRITE (adapter event classification tests) |
| `test/unit/effect/handlers.test.ts` | 283 | REWRITE (handler integration tests) |
| `test/unit/effect/initial-sync.test.ts` | 169 | REWRITE (sync plan → queue) |
| `test/integration/effect/cascade-flow.test.ts` | 156 | REWRITE (end-to-end cascade) |
| `test/integration/effect/queue-consumer.test.ts` | 103 | REWRITE (SimpleQueue + AbortController) |

**New test files** (~5) for handlers without existing tests:
- `test/unit/effect/handlers/audio-cleanup.test.ts`
- `test/unit/effect/handlers/folder-cleanup.test.ts`
- `test/unit/effect/handlers/folder-sync.test.ts`
- `test/unit/effect/adapters/books-adapter.test.ts` (if `events.test.ts` doesn't cover)
- `test/unit/effect/reconciliation.test.ts`

**14 non-Effect test files** (unchanged): audio, rss, scanner, processor, image, e2e, helpers.

## Non-Goals

- Changing the event cascade architecture
- Changing the watcher → HTTP → queue pipeline
- Changing the mirror structure (/data mirrors /audiobooks)
- Changing domain logic (RSS/OPML generation, metadata extraction)

## Migration Strategy: Hybrid (Port Infra + Incremental Handlers)

Infrastructure is copied from opds-generator (battle-tested). Handlers are migrated one-by-one with new tests at each step.

### Step 0: Baseline RSS Measurement

Before any migration work, capture baseline RSS in Docker:

```bash
# Run 500-event stress test, record RSS before/after
docker compose -f docker-compose.test.yml run --rm test bun test test/integration/effect/queue-consumer.test.ts
```

Record: RSS at start, RSS after 500 events, delta per event. Compare against opds-generator's 3.4 KB/event baseline.

**Go/no-go criterion**: if RSS delta > 2 KB/event with Effect Queue (similar to opds-generator's 3.4 KB), proceed — migration is motivated. If RSS delta < 1 KB/event already (suggesting mimalloc behaves differently here), the memory motivation is weak — proceed only for alignment/simplicity reasons, with team agreement.

SimpleQueue was validated at < 1 KB/event in opds-generator's Docker environment (same Bun runtime, same mimalloc allocator). The Step 0 measurement confirms the same pattern holds for opml-generator's event workload.

**Measurement protocol**:
1. Workload: enqueue 500 `FolderMetaSyncRequested` events to a test queue in Docker
2. Measure `process.memoryUsage().rss` before first event and after last event completes
3. Run `Bun.gc(true)` + wait 1s before final measurement (settle allocator)
4. Repeat 3 times, average the delta
5. Delta per event = (RSS_after - RSS_before) / 500

**Post-migration gate (commit 17)**: RSS delta per event must not exceed 1.2x the pre-migration baseline (same protocol, same workload). If it does, investigate before merging — the migration should improve RSS, not degrade it.

## Effect Feature Audit: No Advanced Features in Handlers

**Verified via `rg 'Fiber\.|Ref\.|Schedule\.|Scope\.' src/effect/handlers/`**: zero results.

All 8 handlers use ONLY: `Effect.gen`, `yield*`, `Effect.tryPromise`, `Effect.catchAll`, `Effect.succeed`, `Effect.map`, `Effect.asVoid`, `Effect.fail`. No Fiber (concurrency), Ref (mutable state), Schedule (retry), or Scope (resource management). The migration is a straightforward unwrap of generators into async/await.

`Schedule.spaced` is used in `server.ts` only (periodic reconciliation) — replaced by a completion-aware async loop (see Server Migration section).

## EffectTS Feature Inventory

Complete enumeration of all Effect APIs used in the codebase.

| Module | API | Count | Replacement |
|---|---|---|---|
| Effect | `gen` | 26 | `async function` |
| Effect | `tryPromise` | 25 | `try/catch` or `ResultAsync.fromPromise` |
| Effect | `catchAll` | 22 | `try/catch` |
| Effect | `succeed` | 15 | `return ok(value)` |
| Effect | `asVoid` / `void` | 10 | (removed, no equivalent needed) |
| Effect | `sync` | 9 | direct synchronous call |
| Effect | `map` | 4 | direct value transform |
| Effect | `ensuring` | 3 | `try/finally` |
| Effect | `fail` | 2 | `return err(error)` |
| Effect | `repeat` | 1 | completion-aware async loop |
| Effect | `forEach` | 1 | `for...of` |
| Fiber | `RuntimeFiber` (type) | 2 | `Promise<void>` |
| Fiber | `interrupt` | 2 | `controller.abort()` |
| ManagedRuntime | `make` | 2 | `buildContext()` |
| ManagedRuntime | `runPromise` / `runFork` | 7 | direct `await` / `startConsumer()` |
| Schedule | `spaced` | 1 | completion-aware async loop |
| Queue | `unbounded/offer/take/size` | 5 | `SimpleQueue` class |
| Context | `Tag` | 6 | `AppContext` interface fields |
| Layer | `succeed/effect/mergeAll` | 8 | `buildContext()` factory |
| Match | `value/when/orElse` | 15 | `switch` / `if-else` |
| Schema | `Struct/String/decodeUnknownEither` | 10 | inline type guards |

**Files importing Effect/Schema**: 15 src files + 10 test files = 25 total.
**sync-plan-adapter.ts**: Zero Effect/Schema imports (37 lines, pure TypeScript). No changes needed.

## Design

### Infrastructure (ported from opds-generator)

#### `queue.ts` — copy verbatim from opds-generator

`SimpleQueue<T>` + `UnrolledQueue` + `QueueChunk` — generic, no domain-specific code. Verified: `queue.ts` has **zero imports** (no `node:*`, no project-specific modules). Safe to copy verbatim. Proven in production.

#### `context.ts` — adapted for opml-generator

```typescript
interface AppContext {
  readonly config: ConfigService;
  readonly logger: LoggerService;
  readonly fs: FileSystemService;
  readonly dedup: DeduplicationService;
  readonly queue: SimpleQueue<EventType>;
  readonly handlers: HandlerRegistryService;
}

type HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">;

async function buildContext(): Promise<AppContext> {
  const config = loadConfig();
  const logger = createLogger(config);
  const fs = createFileSystem();
  const dedup = createDeduplication();
  const queue = new SimpleQueue<EventType>();
  const handlers = createHandlerRegistry();
  return { config, logger, fs, dedup, queue, handlers };
}
```

#### ConfigService — fix existing gap

Current `services.ts` ConfigService tag omits `reconcileInterval` despite it being in `config.ts` and used in `server.ts`. The new `AppContext.config` includes all fields:

```typescript
interface ConfigService {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly port: number;
  readonly reconcileInterval: number;
}
```

#### Service Interface Changes

**LoggerService** — methods return `void` (fire-and-forget):

```typescript
interface LoggerService {
  info(tag: string, msg: string, ctx?: LogContext): void;
  warn(tag: string, msg: string, ctx?: LogContext): void;
  error(tag: string, msg: string, err?: unknown, ctx?: LogContext): void;
  debug(tag: string, msg: string, ctx?: LogContext): void;
}
```

Verified in `src/effect/services.ts:86-91`: current Effect signatures return `Effect.Effect<void>`, implemented as `Effect.sync(() => log.info(...))`. The underlying `log.info/warn/error/debug` call `console.log()`/`console.error()` with `JSON.stringify()` — fully synchronous. The `Effect.sync()` wrapper was pure ceremony. No handler awaits or yields on a logger call for its return value — all logger calls are fire-and-forget.

**FileSystemService** — methods return `Promise<T>`:

```typescript
interface FileSystemService {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; size: number }>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  atomicWrite(path: string, content: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
```

Handlers MUST wrap fs calls in try/catch and convert to `err()` at the handler boundary. Consumer adds defensive try/catch backstop.

**Design note**: The Architect review suggested a Result-returning fs service (methods return `Result<T, Error>` instead of `Promise<T>`). However, opds-generator uses the same Promise-returning pattern successfully in production — this is a deliberate alignment choice. The consumer backstop catches any handler that forgets try/catch. If persistent issues arise post-migration, wrapping fs in ResultAsync can be done later without architectural changes.

**DeduplicationService** — returns `boolean` (synchronous):

```typescript
interface DeduplicationService {
  shouldProcess(key: string): boolean;
}
```

Dedup thresholds: 1000 keys / 5000ms cleanup (matches current opml-generator values).

#### Schema Validation → type guards

Verified in `src/effect/types.ts:4-18`: `RawBooksEvent = Schema.Struct({ parent: Schema.String, name: Schema.String, events: Schema.String })` and `RawDataEvent = Schema.Struct({ parent: Schema.String, name: Schema.String, events: Schema.String })`. No transforms, defaults, filters, branded types, or pipe chains — pure structural validation only:

```typescript
function isRawBooksEvent(u: unknown): u is RawBooksEvent {
  return (
    typeof u === "object" && u !== null &&
    "parent" in u && typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u && typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u && typeof (u as Record<string, unknown>).events === "string"
  );
}

function isRawDataEvent(u: unknown): u is RawDataEvent {
  return (
    typeof u === "object" && u !== null &&
    "parent" in u && typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u && typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u && typeof (u as Record<string, unknown>).events === "string"
  );
}
```

#### Handler Type

```typescript
import type { Result } from "neverthrow";

type AsyncHandler = (
  event: EventType,
  deps: HandlerDeps,
) => Promise<Result<readonly EventType[], Error>>;
```

#### UnifiedHandler Adapter (temporary, during migration)

```typescript
type UnifiedHandler =
  | { kind: "effect"; handler: EffectHandler }
  | { kind: "async"; handler: AsyncHandler };
```

Consumer checks `kind` and dispatches accordingly. **Removal gate**: after all 8 handlers are migrated (commit 10), the adapter is removed in commit 12 (consumer migration) when the consumer switches entirely to async dispatch. Add a dedicated test for the adapter's dispatch logic (both branches) in commit 2.

### Handler Migration Pattern

Each handler goes directly from `Effect.gen` + `yield*` to `async/await` + `neverthrow`:

| Current (Effect.gen) | Target (async/await + neverthrow) |
|---|---|
| `Effect.gen(function* () { ... })` | `async function(event, deps) { ... }` |
| `const config = yield* ConfigService` | `const { config } = deps` |
| `const fs = yield* FileSystemService` | `const { fs } = deps` |
| `yield* logger.info(...)` | `deps.logger.info(...)` |
| `yield* Effect.tryPromise({ try: () => ..., catch: ... })` | `try { await ...; } catch { ... }` |
| `Effect.catchAll(() => Effect.succeed(null))` | `try { ... } catch { return null; }` |
| `Effect.succeed([...events])` | `return ok([...events])` |
| `Effect.fail(error)` | `return err(error)` |
| `Effect.ensuring(Effect.sync(() => { ... }))` | `try { ... } finally { ... }` |
| `.pipe(Effect.map(...))` | direct value transform |
| `.pipe(Effect.asVoid)` | (removed) |

### Handler Migration Order

From simplest to most complex:

| # | Handler | ~Lines | Effect APIs | Complexity |
|---|---|---|---|---|
| 1 | parent-meta-sync | 27 | gen, ConfigService, LoggerService | Returns cascade event |
| 2 | folder-entry-xml-changed | 33 | gen, ConfigService, LoggerService | Returns two cascade events |
| 3 | audio-cleanup | 35 | gen, ConfigService, LoggerService, FileSystemService, catchAll | rm + ENOENT + cascade |
| 4 | folder-cleanup | 39 | gen, ConfigService, LoggerService, FileSystemService, catchAll | rm + ENOENT + conditional cascade |
| 5 | folder-sync | 54 | gen, ConfigService, LoggerService, FileSystemService | mkdir + atomicWrite + cascade |
| 6 | opml-sync | 99 | gen, ConfigService, LoggerService, FileSystemService, tryPromise, catchAll | Walk tree + OPML generation |
| 7 | audio-sync | 195 | gen, ConfigService, LoggerService, FileSystemService, tryPromise, catchAll (×8) | ID3 extraction, cover processing, resolveEpisodeNumber, resolvePubDate |
| 8a | folder-meta-sync (structure) | ~120 | gen, ConfigService, LoggerService, FileSystemService | collectChildren, folder detection, empty-feed cleanup |
| 8b | folder-meta-sync (generation) | ~164 | tryPromise, catchAll, map | RSS generation, _entry.xml diff, cascade emission |

Note: folder-meta-sync is split into two commits (8a + 8b) due to size (284 lines total).

Note: `folder-meta-sync` and `opml-sync` also import `readdir`/`stat` directly from `node:fs/promises` alongside the DI `FileSystemService`. During migration, route ALL fs calls through `deps.fs` for consistent testability.

### Adapter Migration

After all handlers:

```typescript
// Before: Effect.gen + yield* DeduplicationService + Match patterns
export const adaptBooksEvent = (raw: RawBooksEvent) =>
  Effect.gen(function* () {
    const dedup = yield* DeduplicationService;
    return Match.value({ event, isDir, ... }).pipe(Match.when(...), ...);
  });

// After: plain sync function, dedup passed explicitly
function adaptBooksEvent(raw: RawBooksEvent, dedup: DeduplicationService): EventType | null {
  const { event, isDir } = parseEvents(raw.events);
  // classifyBooksEvent already uses switch — keep as-is
  const eventType = classifyBooksEvent(raw);
  if (eventType._tag === "Ignored") return null;
  const key = getEventKey(eventType);
  return dedup.shouldProcess(key) ? eventType : null;
}
```

`classifyBooksEvent` currently uses `Match.value/when/orElse` — replace with `switch` or `if-else`.
`classifyDataEvent` is simpler (2 cases + default) — `if-else` is sufficient.

`sync-plan-adapter.ts` — zero Effect imports, no changes needed.

### Consumer Migration

```typescript
async function startConsumer(
  ctx: AppContext,
  signal: AbortSignal,
): Promise<void> {
  let eventCount = 0;
  while (!signal.aborted) {
    let event: EventType;
    try {
      event = await ctx.queue.take(signal);
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }

    const handler = ctx.handlers.get(event._tag);
    if (!handler) continue;

    const path = getEventPath(event);
    const eventId = generateEventId(event, path);
    const startTime = Date.now();

    ctx.logger.info("Consumer", "Handler started", {
      event_type: "handler_start",
      event_id: eventId,
      event_tag: event._tag,
      path,
    });

    try {
      const deps = { config: ctx.config, logger: ctx.logger, fs: ctx.fs };
      const result = await handler(event, deps);
      const duration = Date.now() - startTime;

      if (result.isOk()) {
        ctx.logger.info("Consumer", "Handler completed", {
          event_type: "handler_complete",
          event_id: eventId,
          event_tag: event._tag,
          path,
          duration_ms: duration,
          cascade_count: result.value.length,
        });

        if (result.value.length > 0) {
          ctx.logger.info("Consumer", "Cascades generated", {
            event_type: "cascades_generated",
            event_id: eventId,
            cascade_count: result.value.length,
            cascade_tags: result.value.map((e) => e._tag),
          });
          ctx.queue.enqueueMany(result.value);
        }
      } else {
        ctx.logger.error("Consumer", "handler failed", result.error, {
          event_type: "handler_error",
          event_id: eventId,
          event_tag: event._tag,
          duration_ms: duration,
        });
      }
    } catch (err) {
      ctx.logger.error("Consumer", "unexpected handler throw", err, {
        event_tag: event._tag,
      });
    }

    if (++eventCount % 100 === 0) Bun.gc(true);
  }
}
```

**GC strategy**: `Bun.gc(true)` every 100 events is inherited from opds-generator. The Step 0 baseline benchmark will determine if forced GC is still needed after migration. If SimpleQueue eliminates the per-take allocation pattern, this can be removed or moved to a timer-based approach outside the consumer hot path.

Preserves all existing event lifecycle logging (event_id, handler_start/handler_complete, cascade info).

### Server Migration

| Effect pattern | Replacement |
|---|---|
| `ManagedRuntime.make(LiveLayer)` | `await buildContext()` |
| `runtime.runFork(startConsumer)` | `startConsumer(ctx, controller.signal)` |
| `runtime.runFork(periodicReconciliation)` | `startReconciliation(ctx, controller.signal)` |
| `Fiber.interrupt(fiber)` | `controller.abort()` |
| `runtime.dispose()` | `await Promise.allSettled([consumerTask, reconcileTask])` |
| `Effect.ensuring(Effect.sync(...))` | `try/finally` |
| `Schedule.spaced(interval)` | Completion-aware async loop |
| `runtime.runPromise(queue.enqueue(event))` | `ctx.queue.enqueue(event)` |
| `runtime.runPromise(registerHandlers)` | `registerHandlers(ctx)` (plain function) |
| `Schema.decodeUnknownEither(RawBooksEvent)(body)` | `isRawBooksEvent(body)` (type guard) |
| `yield* adaptBooksEvent(raw)` | `adaptBooksEvent(raw, ctx.dedup)` (sync) |

#### Periodic Reconciliation (replaces Schedule.spaced)

```typescript
async function startReconciliation(
  ctx: AppContext,
  signal: AbortSignal,
): Promise<void> {
  const intervalMs = ctx.config.reconcileInterval * 1000;
  while (!signal.aborted) {
    await sleep(intervalMs, signal).catch(() => {});
    if (signal.aborted) break;
    if (isSyncing) continue;
    if (ctx.queue.size > 0) continue;
    await reconcile(ctx);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
```

`sleep()` is a custom utility defined in this project (not a Node/Bun built-in). It creates a Promise that resolves after `ms` milliseconds, with AbortSignal support: the abort listener calls `clearTimeout` + `reject`, ensuring the reconciliation loop exits promptly on shutdown.

Matches `Schedule.spaced` semantics: waits for previous execution to complete before scheduling next interval. Overlap prevention: `isSyncing` flag + `ctx.queue.size > 0` check before `reconcile()` — same guards as the current `periodicReconciliation` Effect (server.ts:119-128).

#### Graceful Shutdown

**Behavioral improvement**: the current shutdown handler does NOT call `server.stop()` — it only interrupts fibers and disposes the runtime. The new version explicitly stops accepting HTTP requests first, preventing new events from arriving during shutdown.

```typescript
const SHUTDOWN_TIMEOUT_MS = 8_000;

process.on("SIGTERM", async () => {
  server.stop();          // 1. Stop accepting HTTP requests (NEW)
  controller.abort();     // 2. Signal consumer + reconciliation to stop
  await Promise.race([    // 3. Wait for in-flight work with timeout
    Promise.allSettled([consumerTask, reconcileTask]),
    new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  process.exit(0);
});
```

### Cleanup

After server.ts migration:

1. Delete `src/effect/services.ts`
2. Remove `UnifiedHandler` adapter — registry stores `AsyncHandler` only
3. Replace `@effect/schema` validation in `types.ts` with type guards
4. **Verification gate**:
   ```bash
   rg 'from ["'"'"']effect' src/ && echo "FAIL: Effect imports remain" && exit 1
   rg 'from ["'"'"']@effect/schema' src/ && echo "FAIL: Schema imports remain" && exit 1
   echo "PASS: no Effect imports"
   ```
5. `bun remove effect @effect/schema`
6. `npx knip` — verify no dead code

### Test Strategy

Each handler migration rewrites the existing test file (or creates a new one if none exists). Tests use plain mock objects instead of Effect layers.

#### Test Pattern (from opds-generator)

```typescript
import { describe, test, expect } from "bun:test";
import { handlerFunction } from "../../../../src/effect/handlers/handler-name.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const deps: HandlerDeps = {
  config: { filesPath: "/audiobooks", dataPath: "/data", port: 3000, reconcileInterval: 1800 },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fs: {
    mkdir: async () => {},
    rm: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false, size: 0 }),
    exists: async () => false,
    writeFile: async () => {},
    atomicWrite: async () => {},
    symlink: async () => {},
    unlink: async () => {},
  },
};

describe("handlerName handler", () => {
  test("returns empty array for non-matching events", async () => {
    // #given
    const event: EventType = { _tag: "Ignored" };
    // #when
    const result = await handlerFunction(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });
});
```

#### Test Files Per Commit

| Commit | Test File | Action | Key Tests |
|---|---|---|---|
| 3 | `handlers/parent-meta-sync.test.ts` | REWRITE (96 lines) | wrong event → [], cascade to parent, cascade to root, trailing slash |
| 4 | `handlers/folder-entry-xml-changed.test.ts` | REWRITE (121 lines) | wrong event → [], two cascades, root parent |
| 5 | `handlers/audio-cleanup.test.ts` | **NEW** | rm + cascade, ENOENT suppression |
| 6 | `handlers/folder-cleanup.test.ts` | **NEW** | rm + conditional cascade, ENOENT, root |
| 7 | `handlers/folder-sync.test.ts` | **NEW** | mkdir + atomicWrite, root, cascade |
| 8 | `handlers/opml-sync.test.ts` | REWRITE (242 lines) | OPML generation, empty feeds |
| 9 | `handlers/audio-sync.test.ts` | REWRITE (238 lines) | metadata, episode numbering, cover |
| 10 | `handlers/folder-meta-sync.test.ts` | REWRITE (440 lines) | sort, navigation, empty, _entry.xml diff |
| 11 | `adapters/books-adapter.test.ts` | SPLIT from `events.test.ts` | classify all event types, dedup |
| 11 | `adapters/data-adapter.test.ts` | SPLIT from `events.test.ts` | classify entry.xml, _entry.xml, ignored |
| 12 | `queue-consumer.test.ts` | REWRITE (103 lines) | SimpleQueue + AbortController, cascade |
| 12 | `cascade-flow.test.ts` | REWRITE (156 lines) | end-to-end cascade processing |
| 13 | `initial-sync.test.ts` | REWRITE (169 lines) | sync plan → queue (no ManagedRuntime) |
| 13 | `handlers.test.ts` | REWRITE (283 lines) | handler integration (no Effect layers) |
| 14 | `reconciliation.test.ts` | **NEW** | skip during sync, skip with queue, run when idle |

#### Test Helpers (already exist)

opml-generator already has test helpers — no porting needed:
- `test/helpers/fs-helpers.ts` (61 lines)
- `test/helpers/assertions.ts` (77 lines)
- `test/helpers/mock-tools.ts` (104 lines)
- `test/helpers/image-compare.ts` (40 lines)
- `test/setup.ts` (13 lines)

## Commit Plan

```
 0. test: baseline RSS measurement in Docker (Step 0 — go/no-go)
    Measure: RSS before, RSS after 500 events, delta per event
 1. fix: add reconcileInterval to ConfigService (standalone bug fix)
 2. feat: add context.ts, queue.ts, neverthrow dep
    Tests: queue unit tests (ported from opds-generator)
 3. feat: add UnifiedHandler adapter to registry (Effect + async coexist)
    Tests: adapter dispatch tests (both Effect and async branches)
 4. refactor: migrate parent-meta-sync handler
    Tests: REWRITE parent-meta-sync.test.ts (96 lines → mock deps)
 5. refactor: migrate folder-entry-xml-changed handler
    Tests: REWRITE folder-entry-xml-changed.test.ts (121 lines → mock deps)
 6. refactor: migrate audio-cleanup handler
    Tests: NEW audio-cleanup.test.ts
 7. refactor: migrate folder-cleanup handler
    Tests: NEW folder-cleanup.test.ts
 8. refactor: migrate folder-sync handler
    Tests: NEW folder-sync.test.ts
 9. refactor: migrate opml-sync handler
    Tests: REWRITE opml-sync.test.ts (242 lines → mock deps)
10. refactor: migrate audio-sync handler
    Tests: REWRITE audio-sync.test.ts (238 lines → mock deps)
11a. refactor: migrate folder-meta-sync (structure + types)
    Tests: REWRITE folder-meta-sync.test.ts part 1 (collectChildren, empty-feed)
11b. refactor: migrate folder-meta-sync (generation + cascade)
    Tests: REWRITE folder-meta-sync.test.ts part 2 (RSS gen, _entry.xml diff)
12. refactor: migrate adapters (books, data) + server.ts adapter call sites
    Adapters become sync functions. Server.ts call sites change simultaneously:
    `yield* adaptBooksEvent(raw)` → `adaptBooksEvent(raw, ctx.dedup)` (sync call)
    `yield* adaptDataEvent(raw)` → `adaptDataEvent(raw, ctx.dedup)` (sync call)
    Server.ts handleBooksEvent/handleDataEvent remain Effect.gen wrappers until commit 14,
    but the adapter calls inside them become plain function calls (no yield*).
    DeduplicationService passed explicitly from server.ts (ctx.dedup available via buildContext).
    Tests: REWRITE events.test.ts → split into books-adapter.test.ts + data-adapter.test.ts
    Gate: run bun run test:e2e (early E2E smoke test — all handlers + adapters now async)
13. refactor: migrate consumer to async/AbortController (removes UnifiedHandler)
    Tests: REWRITE queue-consumer.test.ts + cascade-flow.test.ts
14. refactor: migrate server.ts — remove remaining Effect.gen wrappers, buildContext, type guards
    handleBooksEvent/handleDataEvent become plain async functions (no Effect.gen/yield*).
    Schema.decodeUnknownEither → isRawBooksEvent/isRawDataEvent type guards.
    ManagedRuntime → buildContext, Fiber → AbortController.
    Tests: REWRITE initial-sync.test.ts + handlers.test.ts (no ManagedRuntime/Layers)
15. feat: add reconciliation tests (TDD — write tests first, then verify impl)
    Tests: NEW reconciliation.test.ts
16. chore: verify zero Effect imports, remove effect + @effect/schema, delete services.ts
    Tests: grep gate verification
17. test: full verification suite + post-migration RSS measurement
    Compare RSS delta against Step 0 baseline (must not exceed 1.2x).
    If Bun.gc(true) not needed post-migration, remove.
18. docs: update CLAUDE.md + ARCHITECTURE.md (remove stale EffectTS references:
    ManagedRuntime, Effect.Match, Layer.mergeAll, @effect/schema)
```

Each commit (3-15) includes both the source migration AND its tests.

**CI gate per commit**: `bun --bun tsc --noEmit && bun run test` must pass after every commit. E2E smoke test (`bun run test:e2e`) runs at commit 12 (after all handlers + adapters migrated) and again at commit 17 (final verification).

## Post-Migration Verification (Commit 16)

```bash
# 1. Type check
bun --bun tsc --noEmit

# 2. Lint + format (zero warnings, zero errors)
bun run fix

# 3. Unit + integration tests (Docker)
bun run test

# 4. E2E tests
bun run test:e2e

# 5. All tests combined
bun run test:all

# 6. Unused exports/deps check
npx knip

# 7. Verify Effect fully removed
rg 'from ["'"'"']effect' src/ test/ && echo "FAIL" || echo "PASS: no Effect imports"
rg 'from ["'"'"']@effect/schema' src/ test/ && echo "FAIL" || echo "PASS: no Schema imports"
```

## Success Criteria

- [ ] All tests pass (green) after each commit
- [ ] `effect` and `@effect/schema` removed from package.json
- [ ] `bun run fix` produces 0 warnings, 0 errors
- [ ] `npx knip` shows no unused exports/deps
- [ ] `bun run test:all` passes (unit + integration + e2e)
- [ ] `bun --bun tsc --noEmit` passes (zero type errors)
- [ ] Zero `effect` / `@effect/schema` imports in src/ and test/
- [ ] New unit tests for all 8 handlers + 2 adapters + consumer + reconciliation
- [ ] `ConfigService` includes `reconcileInterval` (gap fixed)
