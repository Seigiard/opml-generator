import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export async function audioCleanup(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "AudioFileDeleted") return ok([]);

  const { parent, name } = event;
  const { config, logger, fs } = deps;

  const filePath = join(parent, name);
  const relativePath = relative(config.filesPath, filePath);
  const dataDir = join(config.dataPath, relativePath);

  logger.info("AudioCleanup", "Removing", { path: relativePath });

  try {
    await fs.rm(dataDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug("AudioCleanup", "Already removed", { path: relativePath });
    } else {
      return err(error as Error);
    }
  }

  logger.info("AudioCleanup", "Done", { path: relativePath });

  const parentDataDir = dirname(dataDir);
  return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
}
