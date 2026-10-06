import { z } from "zod";
import type { ApplicationLifecycle } from "./app-lifecycle.ts";
import type { AppContext } from "./context.ts";
import { adaptDataEvent } from "./effect/adapters/data-adapter.ts";

const watcherEventSchema = z.object({ parent: z.string(), name: z.string(), events: z.string() });

export function createHttpHandler(ctx: AppContext, lifecycle: ApplicationLifecycle) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (
      req.method === "POST" &&
      (url.pathname === "/events/books" || url.pathname === "/events/data")
    ) {
      if (!lifecycle.isAdmissionReady()) return new Response("Queue not ready", { status: 503 });

      try {
        const body = await req.json();

        if (!lifecycle.isAdmissionReady()) return new Response("Queue not ready", { status: 503 });
        const parsed = watcherEventSchema.safeParse(body);

        if (!parsed.success) {
          ctx.logger.warn("Server", "Invalid watcher event schema", { body });

          return new Response("Invalid event", { status: 400 });
        }

        if (url.pathname === "/events/books") {
          const accepted = lifecycle.admitBooksEvent(parsed.data);

          return new Response(accepted ? "OK" : "Queue not ready", {
            status: accepted ? 202 : 503,
          });
        }

        const event = adaptDataEvent(parsed.data, ctx.dedup);

        if (event === null) return new Response("Deduplicated", { status: 202 });
        ctx.queue.enqueue(event);

        return new Response("OK", { status: 202 });
      } catch (error) {
        ctx.logger.error("Server", "Failed to process watcher event", error);

        return new Response("Error", { status: 500 });
      }
    }

    if (req.method === "POST" && url.pathname === "/resync") {
      if (!lifecycle.isAdmissionReady()) return new Response("Queue not ready", { status: 503 });

      if (lifecycle.isSyncing()) return new Response("Sync already in progress", { status: 409 });

      void lifecycle.runResync();

      return new Response("Resync started", { status: 202 });
    }

    if (req.method === "GET" && url.pathname === "/ready") {
      return new Response(lifecycle.isPublicationReady() ? "Ready" : "Publication not ready", {
        status: lifecycle.isPublicationReady() ? 200 : 503,
      });
    }

    return new Response("Not found", { status: 404 });
  };
}
