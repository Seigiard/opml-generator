import { log } from "./logging/index.ts";

interface Config {
  filesPath: string;
  dataPath: string;
  port: number;
  devMode: boolean;
  logLevel: string;
  reconcileInterval: number;
}

function requireEnv(name: string, defaultValue?: string): string {
  const value = process.env[name] || defaultValue;
  if (!value) {
    log.error("Config", `Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function parsePort(value: string): number {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    log.error("Config", `Invalid PORT: ${value} (must be 1-65535)`);
    process.exit(1);
  }
  return port;
}

function parseReconcileInterval(value: string): number {
  const seconds = parseInt(value, 10);
  if (isNaN(seconds) || seconds < 0 || (seconds > 0 && seconds < 60)) {
    log.error("Config", `Invalid RECONCILE_INTERVAL: ${value} (must be 0 or >= 60)`);
    process.exit(1);
  }
  return seconds;
}

function loadConfig(): Config {
  // Internal Bun server port (nginx proxies to this)
  const port = parsePort(process.env.PORT || "3000");

  return {
    filesPath: requireEnv("FILES", "./audiobooks"),
    dataPath: requireEnv("DATA", "./data"),
    port,
    devMode: process.env.DEV_MODE === "true",
    logLevel: process.env.LOG_LEVEL || "info",
    reconcileInterval: parseReconcileInterval(process.env.RECONCILE_INTERVAL || "1800"),
  };
}

export const config = loadConfig();
