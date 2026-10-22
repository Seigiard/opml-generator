import type { LogLevel, LogEntry, LogContext } from "./types.ts";
import { logErrorSchema, type LogErrorInput } from "./error-schema.ts";
import { Result, Schema } from "effect";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const parsedLevel = Schema.decodeUnknownResult(Schema.Literals(["debug", "info", "warn", "error"]))(
  process.env.LOG_LEVEL || "info",
);

const currentLevelIndex = Result.isSuccess(parsedLevel)
  ? LOG_LEVELS.indexOf(parsedLevel.success)
  : -1;

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

    const errorCtx: LogContext = { ...ctx, ...Schema.decodeUnknownSync(logErrorSchema)(err) };

    emit({ ts: new Date().toISOString(), level: "error", tag, msg, ...errorCtx });
  },
};
