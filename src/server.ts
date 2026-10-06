import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { buildContext } from "./context.ts";
import { ApplicationLifecycle } from "./app-lifecycle.ts";
import { createHttpHandler } from "./http.ts";

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
