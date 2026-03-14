import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { OPML_FILE } from "./constants.ts";
import { generateOpml } from "./rss/opml.ts";
import { log } from "./logging/index.ts";
import type { RawBooksEvent, RawDataEvent } from "./effect/types.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "./effect/adapters/data-adapter.ts";
import { adaptSyncPlan } from "./effect/adapters/sync-plan-adapter.ts";
import { startConsumer } from "./effect/consumer.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { buildContext } from "./context.ts";
import type { AppContext } from "./context.ts";
import { scanFiles, createSyncPlan } from "./scanner.ts";

let isReady = false;
let isSyncing = false;

function isRawBooksEvent(u: unknown): u is RawBooksEvent {
  return (
    typeof u === "object" &&
    u !== null &&
    "parent" in u &&
    typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u &&
    typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u &&
    typeof (u as Record<string, unknown>).events === "string"
  );
}

function isRawDataEvent(u: unknown): u is RawDataEvent {
  return (
    typeof u === "object" &&
    u !== null &&
    "parent" in u &&
    typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u &&
    typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u &&
    typeof (u as Record<string, unknown>).events === "string"
  );
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

async function doSync(ctx: AppContext): Promise<void> {
  log.info("InitialSync", "Starting");
  const startTime = Date.now();

  await mkdir(config.dataPath, { recursive: true });

  const opmlPath = join(config.dataPath, OPML_FILE);
  if (!(await Bun.file(opmlPath).exists())) {
    await Bun.write(opmlPath, generateOpml("Podcasts", []));
    log.info("InitialSync", "Seed feed.opml created");
  }

  const files = await scanFiles(config.filesPath);
  log.info("InitialSync", "Audio files found", { audio_files_found: files.length });

  const plan = await createSyncPlan(files, config.dataPath);
  log.info("InitialSync", "Sync plan created", {
    audio_files_process: plan.toProcess.length,
    audio_files_delete: plan.toDelete.length,
    folders_count: plan.folders.length,
  });

  const events = adaptSyncPlan(plan, config.filesPath);
  ctx.queue.enqueueMany(events);

  const duration = Date.now() - startTime;
  log.info("InitialSync", "Events queued", { entries_count: events.length, duration_ms: duration });
}

async function initialSync(ctx: AppContext): Promise<void> {
  isSyncing = true;
  try {
    await doSync(ctx);
  } finally {
    isSyncing = false;
  }
}

async function resync(ctx: AppContext): Promise<void> {
  isSyncing = true;
  try {
    log.info("Resync", "Starting full resync");
    const entries = await readdir(config.dataPath);
    await Promise.all(entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })));
    log.info("Resync", "Cleared data directory");
    await doSync(ctx);
  } finally {
    isSyncing = false;
  }
}

async function startReconciliation(ctx: AppContext, signal: AbortSignal): Promise<void> {
  const intervalMs = ctx.config.reconcileInterval * 1000;
  while (!signal.aborted) {
    await sleep(intervalMs, signal).catch(() => {});
    if (signal.aborted) break;
    if (isSyncing) continue;
    if (ctx.queue.size > 0) continue;
    try {
      log.info("Reconciliation", "Starting periodic reconciliation");
      isSyncing = true;
      try {
        await doSync(ctx);
      } finally {
        isSyncing = false;
      }
      log.info("Reconciliation", "Completed");
    } catch (error) {
      log.error("Reconciliation", "Failed", error);
    }
  }
}

function handleBooksEvent(body: unknown, ctx: AppContext): { status: number; message: string } {
  if (!isRawBooksEvent(body)) {
    log.warn("Server", "Invalid books event schema", { body });
    return { status: 400, message: "Invalid event" };
  }

  const event = adaptBooksEvent(body, ctx.dedup);
  if (event === null) {
    return { status: 202, message: "Deduplicated" };
  }

  ctx.queue.enqueue(event);
  return { status: 202, message: "OK" };
}

function handleDataEvent(body: unknown, ctx: AppContext): { status: number; message: string } {
  if (!isRawDataEvent(body)) {
    log.warn("Server", "Invalid data event schema", { body });
    return { status: 400, message: "Invalid event" };
  }

  const event = adaptDataEvent(body, ctx.dedup);
  if (event === null) {
    return { status: 202, message: "Deduplicated" };
  }

  ctx.queue.enqueue(event);
  return { status: 202, message: "OK" };
}

const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const ctx = await buildContext();
  const controller = new AbortController();

  try {
    registerHandlers(ctx.handlers);
    log.info("Server", "Handlers registered");

    const consumerTask = startConsumer(ctx, controller.signal);
    log.info("Server", "Consumer started");
    isReady = true;

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/events/books") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });
          try {
            const body = await req.json();
            const result = handleBooksEvent(body, ctx);
            return new Response(result.message, { status: result.status });
          } catch (error) {
            log.error("Server", "Failed to process books event", error);
            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/events/data") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });
          try {
            const body = await req.json();
            const result = handleDataEvent(body, ctx);
            return new Response(result.message, { status: result.status });
          } catch (error) {
            log.error("Server", "Failed to process data event", error);
            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/resync") {
          if (!isReady) return new Response("Queue not ready", { status: 503 });
          if (isSyncing) return new Response("Sync already in progress", { status: 409 });
          resync(ctx).catch((error) => {
            log.error("Server", "Resync failed", error);
          });
          return new Response("Resync started", { status: 202 });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    await initialSync(ctx);

    let reconcileTask: Promise<void> | undefined;
    if (config.reconcileInterval > 0) {
      reconcileTask = startReconciliation(ctx, controller.signal);
      log.info("Server", `Periodic reconciliation enabled (every ${config.reconcileInterval}s)`);
    }

    process.on("SIGTERM", async () => {
      log.info("Server", "Shutting down");
      server.stop();
      controller.abort();
      await Promise.race([
        Promise.allSettled([consumerTask, reconcileTask].filter(Boolean)),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
      process.exit(0);
    });
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

void main();
