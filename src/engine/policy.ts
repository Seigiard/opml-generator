import { join } from "node:path";

export const OPML_ENGINE_STATE_RELATIVE_PATH = "~/.sync-engine";

/**
 * `~/.sync-engine` is outside the cache projection: a source `~` encodes as `~/~`,
 * and generated-name containers only hold reserved generated names.
 */
export function opmlEngineStatePath(dataPath: string): string {
  return join(dataPath, OPML_ENGINE_STATE_RELATIVE_PATH);
}
