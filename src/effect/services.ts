import { Context, Effect, Layer, Queue } from "effect";
import { mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "../config.ts";
import { log } from "../logging/index.ts";
import type { LogContext } from "../logging/types.ts";
import type { EventType } from "./types.ts";

// Config Service
export class ConfigService extends Context.Tag("ConfigService")<
  ConfigService,
  {
    readonly filesPath: string;
    readonly dataPath: string;
    readonly port: number;
    readonly reconcileInterval: number;
  }
>() {}

// Logger Service
export class LoggerService extends Context.Tag("LoggerService")<
  LoggerService,
  {
    readonly info: (tag: string, msg: string, ctx?: LogContext) => Effect.Effect<void>;
    readonly warn: (tag: string, msg: string, ctx?: LogContext) => Effect.Effect<void>;
    readonly error: (tag: string, msg: string, err?: unknown, ctx?: LogContext) => Effect.Effect<void>;
    readonly debug: (tag: string, msg: string, ctx?: LogContext) => Effect.Effect<void>;
  }
>() {}

// FileSystem Service
export class FileSystemService extends Context.Tag("FileSystemService")<
  FileSystemService,
  {
    readonly mkdir: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, Error>;
    readonly rm: (path: string, options?: { recursive?: boolean }) => Effect.Effect<void, Error>;
    readonly readdir: (path: string) => Effect.Effect<string[], Error>;
    readonly stat: (path: string) => Effect.Effect<{ isDirectory: () => boolean; size: number }, Error>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly writeFile: (path: string, content: string) => Effect.Effect<void, Error>;
    readonly atomicWrite: (path: string, content: string) => Effect.Effect<void, Error>;
    readonly symlink: (target: string, path: string) => Effect.Effect<void, Error>;
    readonly unlink: (path: string) => Effect.Effect<void, Error>;
  }
>() {}

// Deduplication Service (TTL-based)
export class DeduplicationService extends Context.Tag("DeduplicationService")<
  DeduplicationService,
  {
    readonly shouldProcess: (key: string) => Effect.Effect<boolean>;
  }
>() {}

// Event Queue Service
export class EventQueueService extends Context.Tag("EventQueueService")<
  EventQueueService,
  {
    readonly enqueue: (event: EventType) => Effect.Effect<void>;
    readonly enqueueMany: (events: readonly EventType[]) => Effect.Effect<void>;
    readonly size: () => Effect.Effect<number>;
    readonly take: () => Effect.Effect<EventType>;
  }
>() {}

// Handler type for registry
export type EventHandler = (
  event: EventType,
) => Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService>;

// Handler Registry Service
export class HandlerRegistry extends Context.Tag("HandlerRegistry")<
  HandlerRegistry,
  {
    readonly get: (tag: string) => EventHandler | undefined;
    readonly register: (tag: string, handler: EventHandler) => void;
  }
>() {}

// Live implementations

const LiveConfigService = Layer.succeed(ConfigService, {
  filesPath: config.filesPath,
  dataPath: config.dataPath,
  port: config.port,
  reconcileInterval: config.reconcileInterval,
});

const LiveLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg, ctx) => Effect.sync(() => log.info(tag, msg, ctx)),
  warn: (tag, msg, ctx) => Effect.sync(() => log.warn(tag, msg, ctx)),
  error: (tag, msg, err, ctx) => Effect.sync(() => log.error(tag, msg, err, ctx)),
  debug: (tag, msg, ctx) => Effect.sync(() => log.debug(tag, msg, ctx)),
});

const LiveFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: (path, options) =>
    Effect.tryPromise({
      try: () => mkdir(path, options),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  rm: (path, options) =>
    Effect.tryPromise({
      try: () => rm(path, options),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  readdir: (path) =>
    Effect.tryPromise({
      try: () => readdir(path),
      catch: (e) => e as Error,
    }),

  stat: (path) =>
    Effect.tryPromise({
      try: () => stat(path),
      catch: (e) => e as Error,
    }).pipe(
      Effect.map((s) => ({
        isDirectory: () => s.isDirectory(),
        size: s.size,
      })),
    ),

  exists: (path) =>
    Effect.tryPromise({
      try: async () => {
        const file = Bun.file(path);
        return file.exists();
      },
      catch: () => false,
    }).pipe(Effect.catchAll(() => Effect.succeed(false))),

  writeFile: (path, content) =>
    Effect.tryPromise({
      try: () => Bun.write(path, content),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  atomicWrite: (path, content) =>
    Effect.tryPromise({
      try: async () => {
        const tmpPath = `${path}.tmp`;
        await Bun.write(tmpPath, content);
        await rename(tmpPath, path);
      },
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  symlink: (target, path) =>
    Effect.tryPromise({
      try: async () => {
        try {
          await unlink(path);
        } catch {
          // ignore if doesn't exist
        }
        await symlink(target, path);
      },
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),

  unlink: (path) =>
    Effect.tryPromise({
      try: () => unlink(path),
      catch: (e) => e as Error,
    }).pipe(Effect.asVoid),
});

// Deduplication Service - TTL-based (500ms window)
const deduplicationState = {
  seen: new Map<string, number>(),
};

const LiveDeduplicationService = Layer.succeed(DeduplicationService, {
  shouldProcess: (key: string) =>
    Effect.sync(() => {
      const now = Date.now();
      const lastSeen = deduplicationState.seen.get(key);
      if (lastSeen && now - lastSeen < 500) return false;
      deduplicationState.seen.set(key, now);
      // Cleanup old entries periodically
      if (deduplicationState.seen.size > 1000) {
        for (const [k, t] of deduplicationState.seen) {
          if (now - t > 5000) deduplicationState.seen.delete(k);
        }
      }
      return true;
    }),
});

// Event Queue Service - created via Layer.effect
const LiveEventQueueService = Layer.effect(
  EventQueueService,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<EventType>();
    return {
      enqueue: (event: EventType) => Queue.offer(queue, event).pipe(Effect.asVoid),
      enqueueMany: (events: readonly EventType[]) => Effect.forEach(events, (e) => Queue.offer(queue, e), { discard: true }),
      size: () => Queue.size(queue),
      take: () => Queue.take(queue),
    };
  }),
);

// Handler Registry - mutable map for handler registration
const handlerRegistryState = {
  handlers: new Map<string, EventHandler>(),
};

const LiveHandlerRegistry = Layer.succeed(HandlerRegistry, {
  get: (tag: string) => handlerRegistryState.handlers.get(tag),
  register: (tag: string, handler: EventHandler) => {
    handlerRegistryState.handlers.set(tag, handler);
  },
});

// Combined live layer
export const LiveLayer = Layer.mergeAll(
  LiveConfigService,
  LiveLoggerService,
  LiveFileSystemService,
  LiveDeduplicationService,
  LiveEventQueueService,
  LiveHandlerRegistry,
);
