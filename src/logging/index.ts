import type { LogLevel, LogEntry, LogContext } from "./types.ts";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(currentLevel);
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

  error(tag: string, msg: string, err?: unknown, ctx?: LogContext): void {
    if (!shouldLog("error")) return;

    const errorCtx: LogContext = { ...ctx };
    if (err instanceof Error) {
      errorCtx.error = err.message;
      errorCtx.error_stack = err.stack;
    } else if (typeof err === "string") {
      errorCtx.error = err;
    } else if (err !== undefined && err !== null) {
      errorCtx.error = JSON.stringify(err);
    }

    emit({ ts: new Date().toISOString(), level: "error", tag, msg, ...errorCtx });
  },
};
