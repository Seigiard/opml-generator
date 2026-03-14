import { mkdir, rm, readdir, stat, rename, symlink, unlink } from "node:fs/promises";
import { config } from "./config.ts";
import { log } from "./logging/index.ts";
import { SimpleQueue } from "./queue.ts";
import type { LogContext } from "./logging/types.ts";
import type { EventType } from "./effect/types.ts";

export interface ConfigService {
  readonly filesPath: string;
  readonly dataPath: string;
  readonly port: number;
  readonly reconcileInterval: number;
}

export interface LoggerService {
  info(tag: string, msg: string, ctx?: LogContext): void;
  warn(tag: string, msg: string, ctx?: LogContext): void;
  error(tag: string, msg: string, err?: unknown, ctx?: LogContext): void;
  debug(tag: string, msg: string, ctx?: LogContext): void;
}

export interface FileSystemService {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; size: number }>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  atomicWrite(path: string, content: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DeduplicationService {
  shouldProcess(key: string): boolean;
}

type AsyncHandler = (event: EventType, deps: HandlerDeps) => Promise<import("neverthrow").Result<readonly EventType[], Error>>;

export interface HandlerRegistryService {
  get(tag: string): AsyncHandler | undefined;
  register(tag: string, handler: AsyncHandler): void;
}

export interface AppContext {
  readonly config: ConfigService;
  readonly logger: LoggerService;
  readonly fs: FileSystemService;
  readonly dedup: DeduplicationService;
  readonly queue: SimpleQueue<EventType>;
  readonly handlers: HandlerRegistryService;
}

export type HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">;

export async function buildContext(): Promise<AppContext> {
  const configService: ConfigService = {
    filesPath: config.filesPath,
    dataPath: config.dataPath,
    port: config.port,
    reconcileInterval: config.reconcileInterval,
  };

  const logger: LoggerService = {
    info: (tag, msg, ctx) => log.info(tag, msg, ctx),
    warn: (tag, msg, ctx) => log.warn(tag, msg, ctx),
    error: (tag, msg, err, ctx) => log.error(tag, msg, err, ctx),
    debug: (tag, msg, ctx) => log.debug(tag, msg, ctx),
  };

  const fsService: FileSystemService = {
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
  };

  const seen = new Map<string, number>();
  const dedup: DeduplicationService = {
    shouldProcess(key: string): boolean {
      const now = Date.now();
      const lastSeen = seen.get(key);
      if (lastSeen && now - lastSeen < 500) return false;
      seen.set(key, now);
      if (seen.size > 1000) {
        for (const [k, t] of seen) {
          if (now - t > 5000) seen.delete(k);
        }
      }
      return true;
    },
  };

  const queue = new SimpleQueue<EventType>();

  const handlerMap = new Map<string, AsyncHandler>();
  const handlers: HandlerRegistryService = {
    get: (tag) => handlerMap.get(tag),
    register: (tag, handler) => handlerMap.set(tag, handler),
  };

  return {
    config: configService,
    logger,
    fs: fsService,
    dedup,
    queue,
    handlers,
  };
}
