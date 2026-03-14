import { ok } from "neverthrow";
import type { Result } from "neverthrow";
import { dirname, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export async function parentMetaSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "EntryXmlChanged") return ok([]);

  const { config, logger } = deps;
  const folderDataDir = event.parent;
  const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
  const parentDataDir = dirname(normalizedDir);
  const parentRelativePath = relative(config.dataPath, parentDataDir);

  if (parentDataDir === config.dataPath || parentRelativePath === ".") {
    logger.info("ParentMetaSync", "Triggering root sync", { path: "/" });
    return ok([{ _tag: "FolderMetaSyncRequested", path: config.dataPath }] as const);
  }

  logger.info("ParentMetaSync", "Triggering parent sync", { path: parentRelativePath });
  return ok([{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const);
}
