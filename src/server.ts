import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { buildContext } from "./context.ts";
import { Cause } from "effect";
import { startEpisodeEngineRuntime, logEpisodeEngineReadyFailure } from "./engine/runtime.ts";
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
          const status = await synchronization.status();

          return Response.json(status, { status: status.available ? 200 : 503 });
        }

        if (req.method === "POST" && url.pathname === "/resync") {
          const admission = await synchronization.requestPass(
            url.searchParams.get("force") === "1",
          );

          return new Response(admission === "queued" ? "Resync queued" : "Resync started", {
            status: admission === "rejected" ? 503 : 202,
          });
        }

        if (req.method === "POST" && url.pathname === "/events/books") {
          const body = await req.json();
          const parsed = watcherEventSchema.safeParse(body);

          if (!parsed.success) return new Response("Invalid event", { status: 400 });
          const admission = await synchronization.notifyBooksEvent(parsed.data);

          return new Response(admission === "rejected" ? "Rejected" : "OK", {
            status: admission === "rejected" ? 503 : 202,
          });
        }

        if (req.method === "POST" && url.pathname === "/events/data")
          return new Response("Ignored", { status: 202 });

        return new Response("Not found", { status: 404 });
      },
    });

    log.info("Server", "Listening", { port: server.port });

    stop = async () => {
      log.info("Server", "Shutting down");
      await server.stop(true);
      await synchronization.stop();
      log.info("Server", "Shutdown finished", { outcome: "completed" });
      process.exit(0);
    };

    if (stopping) await stop();
  } catch (error) {
    log.error("Server", "Startup failed", error);
    process.exit(1);
  }
}

if (import.meta.main) void runServer();
