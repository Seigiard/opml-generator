import { Effect, Fiber, ManagedRuntime, Schedule } from "effect";
import { Schema } from "@effect/schema";
import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { OPML_FILE } from "./constants.ts";
import { generateOpml } from "./rss/opml.ts";
import { log } from "./logging/index.ts";
import { RawBooksEvent, RawDataEvent } from "./effect/types.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "./effect/adapters/data-adapter.ts";
import { adaptSyncPlan } from "./effect/adapters/sync-plan-adapter.ts";
import { startConsumer } from "./effect/consumer.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { EventQueueService, LiveLayer } from "./effect/services.ts";
import { scanFiles, createSyncPlan } from "./scanner.ts";

// Shared runtime - single instance of all services
const runtime = ManagedRuntime.make(LiveLayer);

// Runtime state
let isReady = false;
let isSyncing = false;
let consumerFiber: Fiber.RuntimeFiber<never, Error> | null = null;
let reconcileFiber: Fiber.RuntimeFiber<void, never> | null = null;

// Internal sync logic (no flag management)
const doSync = Effect.gen(function* () {
  const queue = yield* EventQueueService;

  log.info("InitialSync", "Starting");
  const startTime = Date.now();

  yield* Effect.tryPromise({
    try: () => mkdir(config.dataPath, { recursive: true }),
    catch: (e) => e as Error,
  });

  // Seed feed.opml so nginx serves 200 while audio files are processing
  yield* Effect.tryPromise({
    try: async () => {
      const opmlPath = join(config.dataPath, OPML_FILE);
      if (!(await Bun.file(opmlPath).exists())) {
        await Bun.write(opmlPath, generateOpml("Podcasts", []));
        log.info("InitialSync", "Seed feed.opml created");
      }
    },
    catch: (e) => e as Error,
  });

  const files = yield* Effect.tryPromise({
    try: () => scanFiles(config.filesPath),
    catch: (e) => e as Error,
  });
  log.info("InitialSync", "Audio files found", { audio_files_found: files.length });

  const plan = yield* Effect.tryPromise({
    try: () => createSyncPlan(files, config.dataPath),
    catch: (e) => e as Error,
  });
  log.info("InitialSync", "Sync plan created", {
    audio_files_process: plan.toProcess.length,
    audio_files_delete: plan.toDelete.length,
    folders_count: plan.folders.length,
  });

  // Convert sync plan to events
  const events = adaptSyncPlan(plan, config.filesPath);

  // Enqueue all events
  yield* queue.enqueueMany(events);

  const duration = Date.now() - startTime;
  log.info("InitialSync", "Events queued", { entries_count: events.length, duration_ms: duration });
});

// Initial sync: manages isSyncing flag with guaranteed cleanup
const initialSync = Effect.gen(function* () {
  isSyncing = true;
  yield* doSync;
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      isSyncing = false;
    }),
  ),
);

// Resync: clear data, run sync (manages own flag)
const resync = Effect.gen(function* () {
  isSyncing = true;
  log.info("Resync", "Starting full resync");

  // Clear data directory contents (not the directory itself - nginx holds it open)
  yield* Effect.tryPromise({
    try: async () => {
      const entries = await readdir(config.dataPath);
      await Promise.all(entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })));
    },
    catch: (e) => e as Error,
  });
  log.info("Resync", "Cleared data directory");

  // Run sync logic (doSync, not initialSync to avoid double flag management)
  yield* doSync;
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      isSyncing = false;
    }),
  ),
);

// Periodic reconciliation: scan for missed events on interval
const periodicReconciliation = Effect.gen(function* () {
  const queue = yield* EventQueueService;

  yield* Effect.gen(function* () {
    if (isSyncing) {
      log.debug("Reconciliation", "Skipped: sync in progress");
      return;
    }

    const pending = yield* queue.size();
    if (pending > 0) {
      log.debug("Reconciliation", `Skipped: queue has ${pending} pending events`);
      return;
    }

    log.info("Reconciliation", "Starting periodic reconciliation");
    isSyncing = true;
    yield* doSync.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          isSyncing = false;
        }),
      ),
    );
    log.info("Reconciliation", "Completed");
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        log.error("Reconciliation", "Failed", error);
      }),
    ),
    Effect.repeat(Schedule.spaced(`${config.reconcileInterval} seconds`)),
  );
});

// Handle incoming books watcher event
const handleBooksEvent = (body: unknown) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;

    const parseResult = Schema.decodeUnknownEither(RawBooksEvent)(body);
    if (parseResult._tag === "Left") {
      log.warn("Server", "Invalid books event schema", { body });
      return { status: 400, message: "Invalid event" };
    }

    const raw = parseResult.right;
    const event = yield* adaptBooksEvent(raw);
    if (event === null) {
      return { status: 202, message: "Deduplicated" };
    }

    yield* queue.enqueue(event);
    return { status: 202, message: "OK" };
  });

// Handle incoming data watcher event
const handleDataEvent = (body: unknown) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;

    const parseResult = Schema.decodeUnknownEither(RawDataEvent)(body);
    if (parseResult._tag === "Left") {
      log.warn("Server", "Invalid data event schema", { body });
      return { status: 400, message: "Invalid event" };
    }

    const raw = parseResult.right;
    const event = yield* adaptDataEvent(raw);
    if (event === null) {
      return { status: 202, message: "Deduplicated" };
    }

    yield* queue.enqueue(event);
    return { status: 202, message: "OK" };
  });

// Initialize handlers only
const initHandlers = Effect.gen(function* () {
  yield* registerHandlers;
  log.info("Server", "Handlers registered");
});

// Main entry point
async function main(): Promise<void> {
  try {
    // 1. Register handlers
    await runtime.runPromise(initHandlers);

    // 2. Start consumer in background (using runFork for proper fiber execution)
    consumerFiber = runtime.runFork(startConsumer);
    log.info("Server", "Consumer started");
    isReady = true;

    // 3. Start HTTP server
    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        // POST /events/books — receive events from books watcher
        if (req.method === "POST" && url.pathname === "/events/books") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          try {
            const body = await req.json();
            const result = await runtime.runPromise(handleBooksEvent(body));
            return new Response(result.message, { status: result.status });
          } catch (error) {
            log.error("Server", "Failed to process books event", error);
            return new Response("Error", { status: 500 });
          }
        }

        // POST /events/data — receive events from data watcher
        if (req.method === "POST" && url.pathname === "/events/data") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          try {
            const body = await req.json();
            const result = await runtime.runPromise(handleDataEvent(body));
            return new Response(result.message, { status: result.status });
          } catch (error) {
            log.error("Server", "Failed to process data event", error);
            return new Response("Error", { status: 500 });
          }
        }

        // POST /resync — full resync
        if (req.method === "POST" && url.pathname === "/resync") {
          if (!isReady) {
            return new Response("Queue not ready", { status: 503 });
          }

          if (isSyncing) {
            return new Response("Sync already in progress", { status: 409 });
          }

          runtime.runPromise(resync).catch((error) => {
            log.error("Server", "Resync failed", error);
          });
          return new Response("Resync started", { status: 202 });
        }

        // All other routes are handled by nginx
        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    // 4. Run initial sync
    await runtime.runPromise(initialSync);

    // 5. Start periodic reconciliation (if enabled)
    if (config.reconcileInterval > 0) {
      reconcileFiber = runtime.runFork(periodicReconciliation);
      log.info("Server", `Periodic reconciliation enabled (every ${config.reconcileInterval}s)`);
    }
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();

// Graceful shutdown
process.on("SIGTERM", async () => {
  log.info("Server", "Shutting down");
  if (reconcileFiber) {
    await runtime.runPromise(Fiber.interrupt(reconcileFiber));
  }
  if (consumerFiber) {
    await runtime.runPromise(Fiber.interrupt(consumerFiber));
  }
  await runtime.dispose();
  process.exit(0);
});
