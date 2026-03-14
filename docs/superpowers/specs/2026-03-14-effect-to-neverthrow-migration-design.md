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
| src/effect/ + server.ts | 16 | ~1,674 |
| Existing tests (migrate) | 2 | ~167 |
| **New tests (write)** | **~14** | **~1,200** |
| **Total** | **~32** | **~3,041** |

### Current Test Gap

opml-generator has only **2 test files**:
- `test/unit/utils/image.test.ts` (no Effect, unchanged)
- `test/integration/effect/queue-consumer.test.ts` (Effect, must rewrite)

Each migrated handler will get a **new unit test file** modeled after opds-generator's test patterns.

## Non-Goals

- Changing the event cascade architecture
- Changing the watcher → HTTP → queue pipeline
- Changing the mirror structure (/data mirrors /audiobooks)
- Changing domain logic (RSS/OPML generation, metadata extraction)

## Migration Strategy: Hybrid (Port Infra + Incremental Handlers)

Infrastructure is copied from opds-generator (battle-tested). Handlers are migrated one-by-one with new tests at each step.

No Step 0 benchmark — SimpleQueue was already validated against mimalloc in opds-generator's Docker environment (same runtime, same allocator).

## EffectTS Feature Inventory

Complete enumeration of all Effect APIs used in the codebase.

| Module | API | Count | Replacement |
|---|---|---|---|
| Effect | `gen` | 16 | `async function` |
| Effect | `tryPromise` | 14 | `try/catch` or `ResultAsync.fromPromise` |
| Effect | `catchAll` | 14 | `try/catch` |
| Effect | `sync` | 7 | direct synchronous call |
| Effect | `succeed` | 6 | `return ok(value)` |
| Effect | `map` | 6 | direct value transform |
| Effect | `asVoid` / `void` | 8 | (removed, no equivalent needed) |
| Effect | `ensuring` | 3 | `try/finally` |
| Effect | `fail` | 2 | `return err(error)` |
| Effect | `forEach` | 1 | `for...of` |
| Fiber | `RuntimeFiber` (type) | 2 | `Promise<void>` |
| Fiber | `interrupt` | 2 | `controller.abort()` |
| ManagedRuntime | `make` | 1 | `buildContext()` |
| ManagedRuntime | `runPromise` / `runFork` | 7 | direct `await` / `startConsumer()` |
| Schedule | `spaced` | 1 | completion-aware async loop |
| Queue | `unbounded/offer/take/size` | 5 | `SimpleQueue` class |
| Context | `Tag` | 6 | `AppContext` interface fields |
| Layer | `succeed/effect/mergeAll` | 7 | `buildContext()` factory |
| Match | `value/when/orElse` | 6 | `switch` / `if-else` |
| Schema | `Struct/String` | 2 | inline type guards |
| Schema | `decodeUnknownEither` | 2 | `isRawBooksEvent()` / `isRawDataEvent()` |

**Files importing Effect/Schema**: 16 src files + 1 test file = 17 total.
**sync-plan-adapter.ts**: Zero Effect/Schema imports (37 lines, pure TypeScript). No changes needed.

## Design

### Infrastructure (ported from opds-generator)

#### `queue.ts` — copy verbatim from opds-generator

`SimpleQueue<T>` + `UnrolledQueue` + `QueueChunk` — generic, no domain-specific code. Proven in production.

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

Verified: the underlying implementation uses `log.info/warn/error/debug` which call `console.log()`/`console.error()` with `JSON.stringify()` — fully synchronous. The `Effect.sync()` wrapper in services.ts was pure ceremony.

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

**DeduplicationService** — returns `boolean` (synchronous):

```typescript
interface DeduplicationService {
  shouldProcess(key: string): boolean;
}
```

Dedup thresholds: 1000 keys / 5000ms cleanup (matches current opml-generator values).

#### Schema Validation → type guards

`RawBooksEvent` and `RawDataEvent` use only `Schema.Struct({ field: Schema.String })` — pure structural validation:

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

Consumer checks `kind` and dispatches accordingly. Removed once all handlers are async.

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
| 8 | folder-meta-sync | 284 | gen, ConfigService, LoggerService, FileSystemService, tryPromise, catchAll, map | Largest — collectChildren, RSS generation, _entry.xml diff |

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
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
```

Matches `Schedule.spaced` semantics: waits for previous execution to complete before scheduling next interval.

#### Graceful Shutdown

```typescript
const SHUTDOWN_TIMEOUT_MS = 8_000;

process.on("SIGTERM", async () => {
  server.stop();
  controller.abort();
  await Promise.race([
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

Each handler migration includes a **new unit test file** modeled after opds-generator's test patterns.

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

  test("description of behavior", async () => {
    // #given / #when / #then
  });
});
```

#### New Test Files Per Commit

| Commit | New Test File | Tests |
|---|---|---|
| 3 | `test/unit/effect/handlers/parent-meta-sync.test.ts` | wrong event → [], cascade to parent, cascade to root, trailing slash |
| 4 | `test/unit/effect/handlers/folder-entry-xml-changed.test.ts` | wrong event → [], two cascades, root parent handling |
| 5 | `test/unit/effect/handlers/audio-cleanup.test.ts` | rm + cascade, ENOENT suppression |
| 6 | `test/unit/effect/handlers/folder-cleanup.test.ts` | rm + conditional cascade, ENOENT suppression, root = no cascade |
| 7 | `test/unit/effect/handlers/folder-sync.test.ts` | mkdir + atomicWrite, root = no _entry.xml, cascade |
| 8 | `test/unit/effect/handlers/opml-sync.test.ts` | wrong event → [], OPML generation, empty feeds |
| 9 | `test/unit/effect/handlers/audio-sync.test.ts` | metadata extraction, episode numbering, cover handling |
| 10 | `test/unit/effect/handlers/folder-meta-sync.test.ts` | episodes sorting, folders navigation, empty = delete feed, _entry.xml diff |
| 11 | `test/unit/effect/adapters/books-adapter.test.ts` | classify all event types, dedup filtering |
| 11 | `test/unit/effect/adapters/data-adapter.test.ts` | classify entry.xml, _entry.xml, ignored |
| 12 | `test/integration/effect/queue-consumer.test.ts` | Rewrite: SimpleQueue + AbortController, cascade processing |
| 14 | `test/unit/effect/reconciliation.test.ts` | skips during sync, skips with pending queue, runs when idle |

#### Test Helpers (new)

Port from opds-generator:
- `test/helpers/fs-helpers.ts` — `createTempDir`, `cleanupTempDir`, `createFileStructure`, `assertFileExists`
- `test/setup.ts` — global beforeAll/afterAll cleanup

## Commit Plan

```
 1. feat: add context.ts, queue.ts, test helpers, neverthrow dep
    Tests: queue unit tests (from opds-generator), test setup
 2. feat: add UnifiedHandler adapter to registry (Effect + async coexist)
    Tests: adapter type tests
 3. refactor: migrate parent-meta-sync handler
    Tests: NEW unit tests (wrong event, cascade to parent, cascade to root, trailing slash)
 4. refactor: migrate folder-entry-xml-changed handler
    Tests: NEW unit tests (wrong event, two cascades, root parent)
 5. refactor: migrate audio-cleanup handler
    Tests: NEW unit tests (rm + cascade, ENOENT suppression)
 6. refactor: migrate folder-cleanup handler
    Tests: NEW unit tests (rm + conditional cascade, ENOENT, root)
 7. refactor: migrate folder-sync handler
    Tests: NEW unit tests (mkdir + atomicWrite, root, cascade)
 8. refactor: migrate opml-sync handler
    Tests: NEW unit tests (OPML generation, empty feeds)
 9. refactor: migrate audio-sync handler
    Tests: NEW unit tests (metadata, episode numbering, cover)
10. refactor: migrate folder-meta-sync handler
    Tests: NEW unit tests (sort, navigation, empty, _entry.xml diff)
11. refactor: migrate adapters (books, data) + tests
    Tests: NEW unit tests (classify events, dedup)
12. refactor: migrate consumer to async/AbortController
    Tests: REWRITE queue-consumer.test.ts
13. refactor: migrate server.ts — buildContext, AbortController, type guards
    Tests: verify server starts and processes events (integration)
14. feat: fix ConfigService reconcileInterval gap + add reconciliation tests
    Tests: NEW unit tests (skip during sync, skip with queue, run when idle)
15. chore: verify zero Effect imports, remove effect + @effect/schema, delete services.ts
    Tests: grep gate verification
16. test: full verification suite (tsc, fix, test:all, knip)
17. docs: update CLAUDE.md + architecture docs
```

Each commit (3-14) includes both the source migration AND its tests, ensuring `bun test` passes after every commit.

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
