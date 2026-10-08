import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { buildContext } from "./context.ts";
import { ApplicationLifecycle } from "./app-lifecycle.ts";
import { createHttpHandler } from "./http.ts";
import { acquireOutputTree } from "@seigiard/sync-engine";
import { Cause, Effect } from "effect";
import { startEpisodeEngineRuntime, logEpisodeEngineReadyFailure } from "./engine/runtime.ts";
import { opmlEngineStatePath } from "./engine/policy.ts";
import { z } from "zod";

const watcherEventSchema = z.object({ parent: z.string(), name: z.string(), events: z.string() });

export async function runServer(createContext = buildContext): Promise<void> {
  let stopping = false;
  let stop: (() => Promise<void>) | undefined;

  const onSignal = () => {
    if (stopping) return;
    stopping = true;

    if (stop) {
      void stop();
    } else {
      log.info("Server", "Shutting down before context setup completed");
      log.info("Server", "Shutdown finished", { outcome: "completed" });
      process.exit(0);
    }
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const ctx = await createContext();

  try {
    registerHandlers(ctx.handlers);
    log.info("Server", "Handlers registered");

    if (config.syncEngineEpisode) {
      const synchronization = startEpisodeEngineRuntime(ctx);
      synchronization.ready.catch((error) => {
        const failure = Cause.isCause(error)
          ? error
          : error instanceof Error
            ? error
            : new Error(String(error));

        logEpisodeEngineReadyFailure(failure);
        process.exit(1);
      });

      const server = Bun.serve({
        port: config.port,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url);

          if (req.method === "GET" && url.pathname === "/ready") {
            return new Response(synchronization.isReady() ? "Ready" : "Publication not ready", {
              status: synchronization.isReady() ? 200 : 503,
            });
          }

          if (req.method === "POST" && url.pathname === "/resync") {
            void synchronization.requestPass();

            return new Response("Resync started", { status: 202 });
          }

          if (req.method === "POST" && url.pathname === "/events/books") {
            const body = await req.json();
            const parsed = watcherEventSchema.safeParse(body);

            if (!parsed.success) return new Response("Invalid event", { status: 400 });
            void synchronization.notifyBooksEvent(parsed.data);

            return new Response("OK", { status: 202 });
          }

          if (req.method === "POST" && url.pathname === "/events/data")
            return new Response("Ignored", { status: 202 });

          return new Response("Not found", { status: 404 });
        },
      });

      log.info("Server", "Listening", { port: server.port });

      stop = async () => {
        log.info("Server", "Shutting down");
        void server.stop(true);
        await synchronization.stop();
        log.info("Server", "Shutdown finished", { outcome: "completed" });
        process.exit(0);
      };

      if (stopping) await stop();

      return;
    }

    const releaseOutput = await Effect.runPromise(
      acquireOutputTree(ctx.config.dataPath, opmlEngineStatePath(ctx.config.dataPath)),
    );

    const lifecycle = new ApplicationLifecycle(ctx);

    lifecycle.startProcessing();
    log.info("Server", "Consumer started");

    const server = Bun.serve({
      port: config.port,
      hostname: "127.0.0.1",
      fetch: createHttpHandler(ctx, lifecycle),
    });

    log.info("Server", "Listening", { port: server.port });

    stop = async () => {
      log.info("Server", "Shutting down");
      const outcome = await lifecycle.shutdown();
      await server.stop(true);
      await releaseOutput();
      log.info("Server", "Shutdown finished", { outcome });
      process.exit(0);
    };

    if (stopping) {
      await stop();

      return;
    }

    void lifecycle.runInitialSync();

    if (config.reconcileInterval > 0) {
      void lifecycle.startReconciliation(new AbortController().signal);
      log.info("Server", `Periodic reconciliation enabled (every ${config.reconcileInterval}s)`);
    }
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

if (import.meta.main) void runServer();
