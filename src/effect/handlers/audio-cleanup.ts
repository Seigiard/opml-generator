import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, relative } from "node:path";
import { cacheFileSystem } from "../../stopping.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { assertCachePath, cacheParent } from "../../cache-boundary.ts";
import { cachePath } from "../../cache-projection.ts";

export async function audioCleanup(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "AudioFileDeleted") return ok([]);

  const { parent, name } = event;
  const { config, logger } = deps;
  const fs = cacheFileSystem(deps);

  const filePath = join(parent, name);
  const relativePath = relative(config.filesPath, filePath);
  const dataDir = cachePath(config.dataPath, relativePath);

  logger.info("AudioCleanup", "Removing", { path: relativePath });

  try {
    assertCachePath(dataDir, config.dataPath, false);
    await fs.rm(dataDir, { recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.debug("AudioCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  logger.info("AudioCleanup", "Done", { path: relativePath });

  const parentDataDir = cacheParent(dataDir, config.dataPath);

  return ok(
    parentDataDir ? ([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const) : [],
  );
}
