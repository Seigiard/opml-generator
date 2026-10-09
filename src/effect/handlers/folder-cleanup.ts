import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, relative } from "node:path";
import { cacheFileSystem } from "../../stopping.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { assertCachePath, cacheParent } from "../../cache-boundary.ts";
import { cachePath } from "../../cache-projection.ts";

export async function folderCleanup(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "FolderDeleted") return ok([]);

  const { parent, name } = event;
  const { config, logger } = deps;
  const fs = cacheFileSystem(deps);

  const folderPath = join(parent, name);
  const relativePath = relative(config.filesPath, folderPath);
  const folderDataDir = cachePath(config.dataPath, relativePath);

  logger.info("FolderCleanup", "Removing", { path: relativePath });

  try {
    assertCachePath(folderDataDir, config.dataPath, false);
    await fs.rm(folderDataDir, { recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger.debug("FolderCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  logger.info("FolderCleanup", "Done", { path: relativePath });

  const parentDataDir = cacheParent(folderDataDir, config.dataPath);

  return ok(parentDataDir ? [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] : []);
}
