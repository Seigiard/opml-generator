import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { startConsumer } from "./effect/consumer.ts";
import { registerHandlers } from "./effect/handlers/index.ts";
import { buildContext } from "./context.ts";
import { ApplicationLifecycle } from "./app-lifecycle.ts";
import { createHttpHandler } from "./http.ts";

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
      fetch: createHttpHandler(ctx, lifecycle),
    });

    log.info("Server", "Listening", { port: server.port });

    void lifecycle.runInitialSync();

    let reconcileTask: Promise<void> | undefined;

    if (config.reconcileInterval > 0) {
      reconcileTask = lifecycle.startReconciliation(controller.signal);
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
