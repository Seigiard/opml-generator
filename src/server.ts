import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import type { RawBooksEvent, RawDataEvent } from "./effect/types.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "./effect/adapters/data-adapter.ts";
import { startConsumer } from "./effect/consumer.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { buildContext } from "./context.ts";
import type { AppContext } from "./context.ts";
import { ApplicationLifecycle } from "./app-lifecycle.ts";
import { z } from "zod";

const watcherEventSchema = z.object({
  parent: z.string(),
  name: z.string(),
  events: z.string(),
});

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

async function resync(ctx: AppContext, lifecycle: ApplicationLifecycle): Promise<void> {
  log.info("Resync", "Starting full resync");
  const entries = await readdir(config.dataPath);
  await Promise.all(
    entries.map((entry) => rm(join(config.dataPath, entry), { recursive: true, force: true })),
  );
  log.info("Resync", "Cleared data directory");
  await lifecycle.runPublicationPass("Resync");
}

async function startReconciliation(
  ctx: AppContext,
  lifecycle: ApplicationLifecycle,
  signal: AbortSignal,
): Promise<void> {
  const intervalMs = ctx.config.reconcileInterval * 1000;

  while (!signal.aborted) {
    await sleep(intervalMs, signal).catch(() => {});

    if (signal.aborted) break;

    if (lifecycle.isSyncing()) continue;

    if (ctx.queue.size > 0) continue;

    try {
      log.info("Reconciliation", "Starting periodic reconciliation");
      await lifecycle.runPublicationPass("Reconciliation");

      log.info("Reconciliation", "Completed");
    } catch (error) {
      log.error("Reconciliation", "Failed", error);
    }
  }
}

function handleBooksEvent(body: RawBooksEvent, ctx: AppContext) {
  const event = adaptBooksEvent(body, ctx.dedup);

  if (event === null) {
    return { status: 202, message: "Deduplicated" };
  }

  ctx.queue.enqueue(event);

  return { status: 202, message: "OK" };
}

function handleDataEvent(body: RawDataEvent, ctx: AppContext) {
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
    const lifecycle = new ApplicationLifecycle(ctx);

    const consumerTask = startConsumer(ctx, controller.signal);
    log.info("Server", "Consumer started");
    lifecycle.markAdmissionReady();

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/events/books") {
          if (!lifecycle.isAdmissionReady())
            return new Response("Queue not ready", { status: 503 });

          try {
            const body = await req.json();
            const parsed = watcherEventSchema.safeParse(body);

            if (!parsed.success) {
              log.warn("Server", "Invalid books event schema", { body });

              return new Response("Invalid event", { status: 400 });
            }

            const result = handleBooksEvent(parsed.data, ctx);

            return new Response(result.message, { status: result.status });
          } catch (error) {
            log.error("Server", "Failed to process books event", error);

            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/events/data") {
          if (!lifecycle.isAdmissionReady())
            return new Response("Queue not ready", { status: 503 });

          try {
            const body = await req.json();
            const parsed = watcherEventSchema.safeParse(body);

            if (!parsed.success) {
              log.warn("Server", "Invalid data event schema", { body });

              return new Response("Invalid event", { status: 400 });
            }

            const result = handleDataEvent(parsed.data, ctx);

            return new Response(result.message, { status: result.status });
          } catch (error) {
            log.error("Server", "Failed to process data event", error);

            return new Response("Error", { status: 500 });
          }
        }

        if (req.method === "POST" && url.pathname === "/resync") {
          if (!lifecycle.isAdmissionReady())
            return new Response("Queue not ready", { status: 503 });

          if (lifecycle.isSyncing())
            return new Response("Sync already in progress", { status: 409 });
          resync(ctx, lifecycle).catch((error) => {
            log.error("Server", "Resync failed", error);
          });

          return new Response("Resync started", { status: 202 });
        }

        if (req.method === "GET" && url.pathname === "/ready") {
          return new Response(lifecycle.isPublicationReady() ? "Ready" : "Publication not ready", {
            status: lifecycle.isPublicationReady() ? 200 : 503,
          });
        }

        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    void lifecycle.runInitialSync();

    let reconcileTask: Promise<void> | undefined;

    if (config.reconcileInterval > 0) {
      reconcileTask = startReconciliation(ctx, lifecycle, controller.signal);
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
