import { Effect } from "effect";
import { mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "../config.ts";
import { log } from "../logging/index.ts";
import type { HandlerDeps } from "../context.ts";
import type { EventType } from "./types.ts";
import { EventQueueService, HandlerRegistry, LoggerService } from "./services.ts";
import type { UnifiedHandler } from "./services.ts";

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

const bridgeDeps: HandlerDeps = {
  config: {
    filesPath: config.filesPath,
    dataPath: config.dataPath,
    port: config.port,
    reconcileInterval: config.reconcileInterval,
  },
  logger: {
    info: (tag, msg, ctx) => log.info(tag, msg, ctx),
    warn: (tag, msg, ctx) => log.warn(tag, msg, ctx),
    error: (tag, msg, err, ctx) => log.error(tag, msg, err, ctx),
    debug: (tag, msg, ctx) => log.debug(tag, msg, ctx),
  },
  fs: {
    mkdir: async (path, options) => {
      await mkdir(path, options);
    },
    rm: (path, options) => rm(path, options),
    readdir: (path) => readdir(path),
    stat: async (path) => {
      const s = await stat(path);
      return { isDirectory: () => s.isDirectory(), size: s.size };
    },
    exists: async (path) => {
      try {
        return await Bun.file(path).exists();
      } catch {
        return false;
      }
    },
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
    atomicWrite: async (path, content) => {
      const tmpPath = `${path}.tmp`;
      await Bun.write(tmpPath, content);
      await rename(tmpPath, path);
    },
    symlink: async (target, path) => {
      try {
        await unlink(path);
      } catch {
        // ignore if doesn't exist
      }
      await symlink(target, path);
    },
    unlink: (path) => unlink(path),
  },
};

function dispatchHandler(unified: UnifiedHandler, event: EventType) {
  if (unified.kind === "effect") {
    return unified.handler(event).pipe(
      Effect.map((cascades) => ({ ok: true as const, cascades })),
      Effect.catchAll((error: Error) =>
        Effect.succeed({ ok: false as const, cascades: [] as readonly EventType[], error }),
      ),
    );
  }

  return Effect.tryPromise({
    try: async () => {
      const result = await unified.handler(event, bridgeDeps);
      if (result.isOk()) {
        return { ok: true as const, cascades: result.value };
      }
      return { ok: false as const, cascades: [] as readonly EventType[], error: result.error };
    },
    catch: (e) => e as Error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({ ok: false as const, cascades: [] as readonly EventType[], error }),
    ),
  );
}

const processEvent = (event: EventType) =>
  Effect.gen(function* () {
    const queue = yield* EventQueueService;
    const registry = yield* HandlerRegistry;
    const logger = yield* LoggerService;

    const path = getEventPath(event);
    const eventId = generateEventId(event, path);
    const startTime = Date.now();

    log.info("Consumer", "Handler started", {
      event_type: "handler_start",
      event_id: eventId,
      event_tag: event._tag,
      path,
    });

    const unified = registry.get(event._tag);
    if (!unified) {
      yield* logger.warn("Consumer", "No handler found", { event_tag: event._tag });
      return;
    }

    const result = yield* dispatchHandler(unified, event);

    const duration = Date.now() - startTime;

    if (!result.ok) {
      yield* logger.error("Consumer", "Handler failed", (result as { error?: Error }).error, {
        event_type: "handler_error",
        event_id: eventId,
        event_tag: event._tag,
        path,
        duration_ms: duration,
      });
    }

    log.info("Consumer", "Handler completed", {
      event_type: "handler_complete",
      event_id: eventId,
      event_tag: event._tag,
      path,
      duration_ms: duration,
      cascade_count: result.cascades.length,
    });

    if (result.ok && result.cascades.length > 0) {
      log.info("Consumer", "Cascades generated", {
        event_type: "cascades_generated",
        event_id: eventId,
        event_tag: event._tag,
        path,
        cascade_count: result.cascades.length,
        cascade_tags: result.cascades.map((e) => e._tag),
      });

      yield* queue.enqueueMany(result.cascades);
    }
  });

export const startConsumer = Effect.gen(function* () {
  const queue = yield* EventQueueService;
  const logger = yield* LoggerService;

  yield* logger.info("Consumer", "Started processing events");

  while (true) {
    const event = yield* queue.take();
    yield* processEvent(event);
  }
});
