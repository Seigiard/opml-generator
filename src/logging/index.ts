import type { LogLevel, LogEntry, LogContext } from "./types.ts";
import { logErrorSchema, type LogErrorInput } from "./error-schema.ts";
import { z } from "zod";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const parsedLevel = z
  .enum(["debug", "info", "warn", "error"])
  .safeParse(process.env.LOG_LEVEL || "info");

const currentLevelIndex = parsedLevel.success ? LOG_LEVELS.indexOf(parsedLevel.data) : -1;

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= currentLevelIndex;
}

function emit(entry: LogEntry): void {
  const output = JSON.stringify(entry);

  if (entry.level === "error" || entry.level === "warn") {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const log = {
  debug(tag: string, msg: string, ctx?: LogContext): void {
    if (!shouldLog("debug")) return;
    emit({ ts: new Date().toISOString(), level: "debug", tag, msg, ...ctx });
  },

  info(tag: string, msg: string, ctx?: LogContext): void {
    if (!shouldLog("info")) return;
    emit({ ts: new Date().toISOString(), level: "info", tag, msg, ...ctx });
  },

  warn(tag: string, msg: string, ctx?: LogContext): void {
    if (!shouldLog("warn")) return;
    emit({ ts: new Date().toISOString(), level: "warn", tag, msg, ...ctx });
  },

  error(tag: string, msg: string, err?: LogErrorInput, ctx?: LogContext): void {
    if (!shouldLog("error")) return;

    const errorCtx: LogContext = { ...ctx, ...logErrorSchema.parse(err) };

    emit({ ts: new Date().toISOString(), level: "error", tag, msg, ...errorCtx });
  },
};
