import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export async function folderCleanup(event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "FolderDeleted") return ok([]);

  const { parent, name } = event;
  const { config, logger, fs } = deps;

  const folderPath = join(parent, name);
  const relativePath = relative(config.filesPath, folderPath);
  const folderDataDir = join(config.dataPath, relativePath);

  logger.info("FolderCleanup", "Removing", { path: relativePath });

  try {
    await fs.rm(folderDataDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug("FolderCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error as Error);
    }
  }

  logger.info("FolderCleanup", "Done", { path: relativePath });

  const parentDataDir = dirname(folderDataDir);
  if (parentDataDir !== config.dataPath && parentDataDir !== ".") {
    return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
  }
  return ok([]);
}
