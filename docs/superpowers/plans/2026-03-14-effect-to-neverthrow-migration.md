# EffectTS → neverthrow Migration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace EffectTS with neverthrow + vanilla TS in opml-generator, eliminating mimalloc page retention and aligning with opds-generator's proven architecture.

**Architecture:** Port infrastructure (SimpleQueue, AppContext, service interfaces) from opds-generator. Migrate 8 handlers incrementally from Effect.gen → async/await + neverthrow Result. Use temporary UnifiedHandler adapter for coexistence during migration.

**Tech Stack:** Bun, TypeScript, neverthrow, Docker (tests run in containers)

**Spec:** `docs/superpowers/specs/2026-03-14-effect-to-neverthrow-migration-design.md`

**Reference code (opds-generator):**
- `/Users/seigiard/Projects/opds-generator/src/context.ts` — AppContext + buildContext()
- `/Users/seigiard/Projects/opds-generator/src/queue.ts` — SimpleQueue + UnrolledQueue

**CI gate per commit:** `bun --bun tsc --noEmit && bun run test`

---

## Chunk 1: Infrastructure (Commits 0–3)

### Task 0: Baseline RSS Measurement

**Files:** None modified — measurement only

- [ ] **Step 1: Run RSS measurement in Docker**

```bash
docker compose -f docker-compose.test.yml run --rm test bun test test/integration/effect/queue-consumer.test.ts
```

Record `process.memoryUsage().rss` before and after test. If the test doesn't include RSS measurement, note the current test's RSS delta manually from Docker stats.

- [ ] **Step 2: Document baseline**

Record in this plan (or a temp file):
- RSS before: ___
- RSS after: ___
- Delta per event: ___
- Go/no-go: proceed if > 2 KB/event (or proceed for alignment if < 1 KB/event)

---

### Task 1: Fix ConfigService reconcileInterval Gap

**Files:**
- Modify: `src/effect/services.ts:9-16` (ConfigService tag)

- [ ] **Step 1: Add reconcileInterval to ConfigService tag**

In `src/effect/services.ts`, add `reconcileInterval` to the ConfigService Context.Tag:

```typescript
export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly filesPath: string;
    readonly dataPath: string;
    readonly port: number;
    readonly reconcileInterval: number;
  }
>() {}
```

- [ ] **Step 2: Add reconcileInterval to LiveConfigService**

In `src/effect/services.ts`, update LiveConfigService to include the field:

```typescript
const LiveConfigService = Layer.succeed(ConfigService, {
  filesPath: config.filesPath,
  dataPath: config.dataPath,
  port: config.port,
  reconcileInterval: config.reconcileInterval,
});
```

- [ ] **Step 3: Verify and commit**

```bash
bun --bun tsc --noEmit && bun run test
git add src/effect/services.ts
git commit -m "fix: add reconcileInterval to ConfigService tag"
```

---

### Task 2: Add Infrastructure (context.ts, queue.ts, neverthrow)

**Files:**
- Create: `src/queue.ts`
- Create: `src/context.ts`
- Modify: `package.json` (add neverthrow)
- Create: `test/unit/queue.test.ts`

- [ ] **Step 1: Install neverthrow**

```bash
bun add neverthrow
```

- [ ] **Step 2: Copy queue.ts from opds-generator**

Copy `/Users/seigiard/Projects/opds-generator/src/queue.ts` verbatim to `src/queue.ts`. This file has zero imports — safe to copy as-is.

- [ ] **Step 3: Create context.ts**

Create `src/context.ts` adapted from opds-generator. Key differences from opds-generator:
- Dedup thresholds: `1000` keys / `5000`ms cleanup (vs 100/2000ms in opds)
- All other service interfaces are identical

Use `/Users/seigiard/Projects/opds-generator/src/context.ts` as the template. Adapt:
- Import `config` from `./config.ts`
- Import `log` from `./logging/index.ts`
- Import `SimpleQueue` from `./queue.ts`
- Import `EventType` from `./effect/types.ts`
- Change dedup thresholds: `seen.size > 1000` and `now - t > 5000`

- [ ] **Step 4: Write queue unit tests**

Create `test/unit/queue.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { SimpleQueue, QueueChunk, UnrolledQueue, CHUNK_SIZE } from "../../src/queue.ts";

describe("QueueChunk", () => {
  test("push and shift items", () => {
    // #given
    const chunk = new QueueChunk<number>();
    // #when
    chunk.push(1);
    chunk.push(2);
    // #then
    expect(chunk.shift()).toBe(1);
    expect(chunk.shift()).toBe(2);
    expect(chunk.length).toBe(0);
  });

  test("returns false when full", () => {
    // #given
    const chunk = new QueueChunk<number>();
    for (let i = 0; i < CHUNK_SIZE; i++) chunk.push(i);
    // #then
    expect(chunk.push(999)).toBe(false);
  });
});

describe("SimpleQueue", () => {
  test("enqueue and take (sync path)", async () => {
    // #given
    const q = new SimpleQueue<string>();
    q.enqueue("a");
    q.enqueue("b");
    // #when / #then
    expect(await q.take()).toBe("a");
    expect(await q.take()).toBe("b");
  });

  test("take waits for enqueue (async path)", async () => {
    // #given
    const q = new SimpleQueue<string>();
    const promise = q.take();
    // #when
    q.enqueue("delayed");
    // #then
    expect(await promise).toBe("delayed");
  });

  test("take respects AbortSignal", async () => {
    // #given
    const q = new SimpleQueue<string>();
    const controller = new AbortController();
    const promise = q.take(controller.signal);
    // #when
    controller.abort();
    // #then
    await expect(promise).rejects.toThrow();
  });

  test("enqueueMany adds multiple items", async () => {
    // #given
    const q = new SimpleQueue<number>();
    q.enqueueMany([1, 2, 3]);
    // #then
    expect(q.size).toBe(3);
    expect(await q.take()).toBe(1);
  });
});
```

- [ ] **Step 5: Run tests and commit**

```bash
bun --bun tsc --noEmit && bun run test
git add src/queue.ts src/context.ts test/unit/queue.test.ts package.json bun.lockb
git commit -m "feat: add AppContext, SimpleQueue, service interfaces, neverthrow"
```

---

### Task 3: Add UnifiedHandler Adapter

**Files:**
- Modify: `src/context.ts` (add UnifiedHandler type)
- Modify: `src/effect/handlers/index.ts` (support both handler kinds)

- [ ] **Step 1: Add UnifiedHandler types to context.ts**

Add to `src/context.ts`:

```typescript
import type { Effect } from "effect";
import type { ConfigService as EffectConfigService, LoggerService as EffectLoggerService, FileSystemService as EffectFileSystemService } from "./effect/services.ts";

export type EffectHandler = (event: EventType) => Effect.Effect<readonly EventType[], Error, EffectConfigService | EffectLoggerService | EffectFileSystemService>;

export type UnifiedHandler =
  | { kind: "effect"; handler: EffectHandler }
  | { kind: "async"; handler: AsyncHandler };
```

Update `HandlerRegistryService` to accept `UnifiedHandler`:

```typescript
export interface HandlerRegistryService {
  get(tag: string): UnifiedHandler | undefined;
  register(tag: string, handler: UnifiedHandler): void;
  registerAsync(tag: string, handler: AsyncHandler): void;
  registerEffect(tag: string, handler: EffectHandler): void;
}
```

- [ ] **Step 2: Update buildContext handler registry**

```typescript
const handlerMap = new Map<string, UnifiedHandler>();
const handlers: HandlerRegistryService = {
  get: (tag) => handlerMap.get(tag),
  register: (tag, handler) => handlerMap.set(tag, handler),
  registerAsync: (tag, handler) => handlerMap.set(tag, { kind: "async", handler }),
  registerEffect: (tag, handler) => handlerMap.set(tag, { kind: "effect", handler }),
};
```

- [ ] **Step 3: Update handler registration in handlers/index.ts**

Change `src/effect/handlers/index.ts` to use `registerEffect` for all existing handlers (they're still Effect-based at this point).

- [ ] **Step 4: Write adapter dispatch tests**

Create `test/unit/effect/unified-handler.test.ts` that tests both the Effect and async branches of the UnifiedHandler dispatch.

- [ ] **Step 5: Run tests and commit**

```bash
bun --bun tsc --noEmit && bun run test
git add src/context.ts src/effect/handlers/index.ts test/unit/effect/unified-handler.test.ts
git commit -m "feat: add UnifiedHandler adapter for Effect/async coexistence"
```

---

## Chunk 2: Simple Handler Migration (Commits 4–8)

Each handler follows the same pattern:
1. Rewrite handler: `Effect.gen` → `async function` returning `Result<EventType[], Error>`
2. Rewrite/create test: Effect layers → plain mock `HandlerDeps`
3. Update registration: `registerEffect` → `registerAsync`
4. Run tests, commit

**Mock deps template** (reuse across all handler tests):

```typescript
import type { HandlerDeps } from "../../../../src/context.ts";

const mockDeps = (overrides?: Partial<HandlerDeps>): HandlerDeps => ({
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
  ...overrides,
});
```

### Task 4: Migrate parent-meta-sync

**Files:**
- Modify: `src/effect/handlers/parent-meta-sync.ts`
- Rewrite: `test/unit/effect/handlers/parent-meta-sync.test.ts`
- Modify: `src/effect/handlers/index.ts` (registerAsync for this handler)

- [ ] **Step 1: Rewrite handler**

Replace Effect.gen with async function. See spec section "Handler Migration Pattern" for the mapping. Key changes:
- `yield* ConfigService` → `deps.config`
- `yield* LoggerService` → `deps.logger`
- Return `ok([...events])` instead of `return [...events]`
- Wrap in try/catch returning `err()`

- [ ] **Step 2: Rewrite test**

Use mock deps pattern. Test cases from spec:
- wrong event → `ok([])`
- cascade to parent directory
- cascade to root when parent is root
- trailing slash handling

- [ ] **Step 3: Update registration**

In `src/effect/handlers/index.ts`, change `registry.register("EntryXmlChanged", parentMetaSync)` to `registry.registerAsync("EntryXmlChanged", parentMetaSync)`.

- [ ] **Step 4: Run tests and commit**

```bash
bun --bun tsc --noEmit && bun run test
git add src/effect/handlers/parent-meta-sync.ts test/unit/effect/handlers/parent-meta-sync.test.ts src/effect/handlers/index.ts
git commit -m "refactor: migrate parent-meta-sync to async/neverthrow"
```

---

### Task 5: Migrate folder-entry-xml-changed

**Files:**
- Modify: `src/effect/handlers/folder-entry-xml-changed.ts`
- Rewrite: `test/unit/effect/handlers/folder-entry-xml-changed.test.ts`
- Modify: `src/effect/handlers/index.ts`

Same pattern as Task 4. Test cases: wrong event → [], two cascade events, root parent handling.

- [ ] **Step 1: Rewrite handler**
- [ ] **Step 2: Rewrite test**
- [ ] **Step 3: Update registration**
- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "refactor: migrate folder-entry-xml-changed to async/neverthrow"
```

---

### Task 6: Migrate audio-cleanup

**Files:**
- Modify: `src/effect/handlers/audio-cleanup.ts`
- Create: `test/unit/effect/handlers/audio-cleanup.test.ts` (NEW)
- Modify: `src/effect/handlers/index.ts`

Key pattern: `fs.rm` with ENOENT suppression via try/catch:

```typescript
try {
  await deps.fs.rm(dataDir, { recursive: true });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  deps.logger.debug("AudioCleanup", "Already removed", { path: relativePath });
}
```

Test cases: rm + cascade event, ENOENT suppression.

- [ ] **Step 1: Rewrite handler**
- [ ] **Step 2: Create new test file**
- [ ] **Step 3: Update registration**
- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "refactor: migrate audio-cleanup to async/neverthrow"
```

---

### Task 7: Migrate folder-cleanup

**Files:**
- Modify: `src/effect/handlers/folder-cleanup.ts`
- Create: `test/unit/effect/handlers/folder-cleanup.test.ts` (NEW)
- Modify: `src/effect/handlers/index.ts`

Same ENOENT pattern as audio-cleanup. Key difference: conditional cascade (no cascade if at root).

- [ ] **Step 1-4: Same pattern**

```bash
git commit -m "refactor: migrate folder-cleanup to async/neverthrow"
```

---

### Task 8: Migrate folder-sync

**Files:**
- Modify: `src/effect/handlers/folder-sync.ts`
- Create: `test/unit/effect/handlers/folder-sync.test.ts` (NEW)
- Modify: `src/effect/handlers/index.ts`

Key pattern: mkdir + atomicWrite for _entry.xml. Root folder = no _entry.xml. Always cascades FolderMetaSyncRequested.

- [ ] **Step 1-4: Same pattern**

```bash
git commit -m "refactor: migrate folder-sync to async/neverthrow"
```

---

## Chunk 3: Complex Handler Migration (Commits 9–11b)

### Task 9: Migrate opml-sync

**Files:**
- Modify: `src/effect/handlers/opml-sync.ts`
- Rewrite: `test/unit/effect/handlers/opml-sync.test.ts`
- Modify: `src/effect/handlers/index.ts`

**Important**: `opml-sync.ts` imports `readdir`/`stat` directly from `node:fs/promises` in `collectPodcastFeeds`/`walkDirectory`. During migration, these standalone async functions must receive `deps.fs` as a parameter for testability:

```typescript
async function collectPodcastFeeds(dataRoot: string, fs: FileSystemService): Promise<DiscoveredFeed[]> {
  // ... use fs.readdir() and fs.stat() instead of raw imports
}
```

- [ ] **Step 1: Rewrite handler + thread deps.fs through collectPodcastFeeds/walkDirectory**
- [ ] **Step 2: Rewrite test with mock fs**
- [ ] **Step 3: Update registration**
- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "refactor: migrate opml-sync to async/neverthrow"
```

---

### Task 10: Migrate audio-sync

**Files:**
- Modify: `src/effect/handlers/audio-sync.ts`
- Rewrite: `test/unit/effect/handlers/audio-sync.test.ts`
- Modify: `src/effect/handlers/index.ts`

Largest handler (195 lines). Contains helper functions: `resolveEpisodeNumber`, `resolvePubDate`, `handleFolderCover`. Each must receive `deps` or relevant subset.

Key conversions:
- `yield* Effect.tryPromise({ try: () => readAudioMetadata(...) })` → `try { await readAudioMetadata(...) } catch { ... }`
- Multiple nested `Effect.catchAll(() => Effect.succeed(null))` → try/catch with fallback returns
- `yield* fs.exists(...)` → `await deps.fs.exists(...)`

- [ ] **Step 1: Rewrite handler + helpers to accept deps**
- [ ] **Step 2: Rewrite test**
- [ ] **Step 3: Update registration**
- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "refactor: migrate audio-sync to async/neverthrow"
```

---

### Task 11a: Migrate folder-meta-sync (structure)

**Files:**
- Modify: `src/effect/handlers/folder-meta-sync.ts` (first half)
- Rewrite: `test/unit/effect/handlers/folder-meta-sync.test.ts` (part 1)

Migrate the structural parts:
- `collectChildren(dir, fs)` — thread `deps.fs` through, replace raw `readdir`/`stat` imports
- `parseEntryXml`, `parseFolderEntryXml`, `sortEpisodes` — pure functions, no changes needed
- Source folder existence check
- Empty feed cleanup logic

- [ ] **Step 1: Refactor collectChildren to accept FileSystemService**
- [ ] **Step 2: Migrate structural handler logic (early returns, source check, empty cleanup)**
- [ ] **Step 3: Write tests for collectChildren and empty-feed cleanup**
- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "refactor: migrate folder-meta-sync structure to async/neverthrow"
```

---

### Task 11b: Migrate folder-meta-sync (generation + cascade)

**Files:**
- Modify: `src/effect/handlers/folder-meta-sync.ts` (second half)
- Rewrite: `test/unit/effect/handlers/folder-meta-sync.test.ts` (part 2)

Migrate:
- Episode sorting + RSS generation
- Folder navigation feed generation
- _entry.xml diff (only write if content changed)
- Cascade emission (FeedXmlCreated)

- [ ] **Step 1: Migrate generation logic**
- [ ] **Step 2: Write tests for RSS generation, _entry.xml diff, cascade**
- [ ] **Step 3: Update registration to registerAsync**
- [ ] **Step 4: Run tests and commit**

```bash
git commit -m "refactor: migrate folder-meta-sync generation to async/neverthrow"
```

---

## Chunk 4: System Migration (Commits 12–15)

### Task 12: Migrate Adapters + Server Call Sites

**Files:**
- Modify: `src/effect/adapters/books-adapter.ts`
- Modify: `src/effect/adapters/data-adapter.ts`
- Modify: `src/server.ts:151-190` (adapter call sites only)
- Rewrite: `test/unit/effect/events.test.ts` → split into:
  - Create: `test/unit/effect/adapters/books-adapter.test.ts`
  - Create: `test/unit/effect/adapters/data-adapter.test.ts`

**Critical**: Adapters AND their server.ts call sites migrate together (same commit). Adapters become sync functions. Inside server.ts's `handleBooksEvent`/`handleDataEvent` (which remain Effect.gen wrappers until commit 14), the `yield*` adapter calls become plain function calls:

```typescript
// Before (server.ts):
const event = yield* adaptBooksEvent(raw);
// After (server.ts):
const event = adaptBooksEvent(raw, ctx.dedup);
```

This is valid — Effect.gen allows mixing `yield*` with plain expressions.

**books-adapter.ts conversion:**
- Remove `Effect`, `Match` imports
- `classifyBooksEvent`: replace `Match.value/when/orElse` with `switch` statement
- `adaptBooksEvent`: plain sync function, receive `dedup: DeduplicationService` as parameter
- Keep `parseEvents`, `isValidAudioExtension`, `getEventKey` (pure functions, no Effect)

**data-adapter.ts conversion:**
- Replace `Match.value/when/orElse` with `if-else` (2 cases + default)
- Same pattern as books-adapter

- [ ] **Step 1: Rewrite books-adapter.ts**
- [ ] **Step 2: Rewrite data-adapter.ts**
- [ ] **Step 3: Update server.ts adapter call sites (yield* → plain calls)**
- [ ] **Step 4: Split events.test.ts into books-adapter.test.ts + data-adapter.test.ts**
- [ ] **Step 5: Delete old events.test.ts**
- [ ] **Step 6: Run tests (including E2E smoke test)**

```bash
bun --bun tsc --noEmit && bun run test
bun run test:e2e
git add src/effect/adapters/ src/server.ts test/unit/effect/adapters/ test/unit/effect/events.test.ts
git commit -m "refactor: migrate adapters to sync + update server.ts call sites"
```

---

### Task 13: Migrate Consumer

**Files:**
- Modify: `src/effect/consumer.ts`
- Modify: `src/context.ts` (remove UnifiedHandler, registry uses AsyncHandler only)
- Modify: `src/effect/handlers/index.ts` (simplify registration)
- Rewrite: `test/integration/effect/queue-consumer.test.ts`
- Rewrite: `test/integration/effect/cascade-flow.test.ts`

The consumer becomes a `while (!signal.aborted)` loop using `ctx.queue.take(signal)`. All handlers are now async — remove UnifiedHandler adapter. See spec "Consumer Migration" section for the full implementation.

Key changes:
- Remove Effect/Fiber imports
- `HandlerRegistryService.get()` returns `AsyncHandler | undefined` (not UnifiedHandler)
- `processEvent` becomes inline logic in the while loop
- Preserve all event lifecycle logging (event_id, handler_start/complete, cascades)
- Add `Bun.gc(true)` every 100 events

- [ ] **Step 1: Rewrite consumer.ts**
- [ ] **Step 2: Simplify context.ts — remove UnifiedHandler types, registry returns AsyncHandler**
- [ ] **Step 3: Simplify handlers/index.ts — use plain `register()` calls**
- [ ] **Step 4: Rewrite queue-consumer.test.ts (SimpleQueue + AbortController)**
- [ ] **Step 5: Rewrite cascade-flow.test.ts**
- [ ] **Step 6: Run tests and commit**

```bash
git commit -m "refactor: migrate consumer to async/AbortController, remove UnifiedHandler"
```

---

### Task 14: Migrate server.ts

**Files:**
- Modify: `src/server.ts` (full rewrite of Effect portions)
- Rewrite: `test/unit/effect/initial-sync.test.ts`
- Rewrite: `test/unit/effect/handlers.test.ts`

Remove all remaining Effect from server.ts:
- `ManagedRuntime.make(LiveLayer)` → `await buildContext()`
- `runtime.runFork(startConsumer)` → `startConsumer(ctx, controller.signal)`
- `runtime.runFork(periodicReconciliation)` → `startReconciliation(ctx, controller.signal)`
- `Fiber.interrupt` → `controller.abort()`
- `runtime.dispose()` → `Promise.allSettled([consumerTask, reconcileTask])`
- `Effect.ensuring` → `try/finally`
- `Schema.decodeUnknownEither` → `isRawBooksEvent()` / `isRawDataEvent()` type guards
- `handleBooksEvent` / `handleDataEvent` → plain async functions
- Add `server.stop()` to SIGTERM handler (behavioral improvement)
- Add `sleep()` utility function
- Add `startReconciliation()` with completion-aware async loop

Type guards go in `src/effect/types.ts` (replacing Schema definitions).

- [ ] **Step 1: Add type guards to types.ts, remove Schema imports**
- [ ] **Step 2: Rewrite server.ts main(), initialSync, resync**
- [ ] **Step 3: Add sleep(), startReconciliation() to server.ts**
- [ ] **Step 4: Add graceful shutdown with server.stop() + AbortController**
- [ ] **Step 5: Rewrite initial-sync.test.ts**
- [ ] **Step 6: Rewrite handlers.test.ts**
- [ ] **Step 7: Run tests and commit**

```bash
git commit -m "refactor: migrate server.ts — remove ManagedRuntime, add buildContext"
```

---

### Task 15: Add Reconciliation Tests (TDD)

**Files:**
- Create: `test/unit/effect/reconciliation.test.ts`

Write tests FIRST (Red), then verify the startReconciliation implementation satisfies them.

Test cases:
- Skips reconciliation when `isSyncing` is true
- Skips when queue has pending events
- Runs reconciliation when idle
- Respects AbortSignal (exits promptly on abort)
- Waits for current reconciliation to complete before next interval

- [ ] **Step 1: Write failing tests**
- [ ] **Step 2: Verify tests pass with current implementation**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add reconciliation tests"
```

---

## Chunk 5: Cleanup & Verification (Commits 16–18)

### Task 16: Remove Effect Dependencies

**Files:**
- Delete: `src/effect/services.ts`
- Modify: `src/effect/types.ts` (remove Schema import, keep EventType + type guards)
- Modify: `package.json` (remove effect, @effect/schema)

- [ ] **Step 1: Run verification gate**

```bash
rg 'from ["'"'"']effect' src/ && echo "FAIL" && exit 1 || echo "PASS"
rg 'from ["'"'"']@effect/schema' src/ && echo "FAIL" && exit 1 || echo "PASS"
```

If any imports remain, fix them before proceeding.

- [ ] **Step 2: Delete services.ts**

```bash
rm src/effect/services.ts
```

- [ ] **Step 3: Clean up types.ts**

Remove `import { Schema } from "@effect/schema"` and the Schema.Struct definitions. Keep the `EventType` union and `RawBooksEvent`/`RawDataEvent` as plain interfaces with type guards (already added in Task 14).

- [ ] **Step 4: Remove dependencies**

```bash
bun remove effect @effect/schema
```

- [ ] **Step 5: Verify no Effect imports in tests**

```bash
rg 'from ["'"'"']effect' test/ && echo "FAIL" && exit 1 || echo "PASS"
rg 'from ["'"'"']@effect/schema' test/ && echo "FAIL" && exit 1 || echo "PASS"
```

- [ ] **Step 6: Run knip and full test suite**

```bash
npx knip
bun --bun tsc --noEmit
bun run fix
bun run test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove effect + @effect/schema dependencies"
```

---

### Task 17: Full Verification + Post-Migration RSS

**Files:** None — verification only

- [ ] **Step 1: Full verification suite**

```bash
bun --bun tsc --noEmit
bun run fix
bun run test
bun run test:e2e
bun run test:all
npx knip
```

All must pass with zero errors/warnings.

- [ ] **Step 2: Post-migration RSS measurement**

Same protocol as Step 0:
1. Enqueue 500 `FolderMetaSyncRequested` events in Docker
2. Measure RSS before/after, `Bun.gc(true)` + 1s settle
3. Average over 3 runs
4. Compare against Step 0 baseline

**Gate:** RSS delta must not exceed 1.2x baseline.

If Bun.gc(true) is no longer needed (RSS improvement significant), remove it from consumer.ts and re-run tests.

- [ ] **Step 3: Commit any Bun.gc changes**

```bash
git commit -m "test: post-migration RSS verification — [X] KB/event (was [Y])"
```

---

### Task 18: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ARCHITECTURE.md` (if exists)

- [ ] **Step 1: Update CLAUDE.md**

Remove references to EffectTS patterns. Update:
- DI section: describe AppContext + HandlerDeps
- Key Patterns section: neverthrow Result, try/catch + ok/err
- Architecture section: remove ManagedRuntime, Layer, Fiber references
- Add SimpleQueue, AbortController patterns

- [ ] **Step 2: Update ARCHITECTURE.md**

Remove stale EffectTS references:
- ManagedRuntime, Effect.Match, Layer.mergeAll, @effect/schema
- Replace with: buildContext(), switch/if-else, AppContext, inline type guards

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: update documentation for neverthrow architecture"
```

---

## Summary

| Chunk | Tasks | Commits | Description |
|-------|-------|---------|-------------|
| 1 | 0–3 | 0–3 | Infrastructure: benchmark, config fix, context.ts, queue.ts, UnifiedHandler |
| 2 | 4–8 | 4–8 | Simple handlers: parent-meta-sync through folder-sync |
| 3 | 9–11b | 9–11b | Complex handlers: opml-sync, audio-sync, folder-meta-sync (split) |
| 4 | 12–15 | 12–15 | System: adapters, consumer, server.ts, reconciliation |
| 5 | 16–18 | 16–18 | Cleanup: remove Effect deps, verify, document |

**Total: 19 commits, ~4,221 lines across ~30 files**
