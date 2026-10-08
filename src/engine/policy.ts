import { join } from "node:path";

const ENGINE_STATE_DIRECTORY = ".sync-engine";

/**
 * `~/.sync-engine` is outside the cache projection: a source `~` encodes as `~/~`,
 * and generated-name containers only hold reserved generated names.
 */
export function opmlEngineStatePath(dataPath: string): string {
  return join(dataPath, "~", ENGINE_STATE_DIRECTORY);
}
