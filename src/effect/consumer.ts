import type { AppContext } from "../context.ts";
import type { EventType } from "./types.ts";

export function generateEventId(event: EventType, path: string | undefined): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 7);
  return `${event._tag}:${path ?? "unknown"}:${timestamp}:${random}`;
}

export function getEventPath(event: EventType): string | undefined {
  if ("path" in event && typeof event.path === "string") return event.path;
  if ("parent" in event && "name" in event) return `${event.parent}/${event.name}`;
  if ("parent" in event && typeof event.parent === "string") return event.parent;
  return undefined;
}

export async function startConsumer(ctx: AppContext, signal: AbortSignal): Promise<void> {
  let eventCount = 0;
  ctx.logger.info("Consumer", "Started processing events");

  while (!signal.aborted) {
    let event: EventType;
    try {
      event = await ctx.queue.take(signal);
    } catch {
      if (signal.aborted) break;
      throw new Error("Queue take failed unexpectedly");
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
