import { ok } from "neverthrow";
import type { Result } from "neverthrow";
import { dirname, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";

export async function folderEntryXmlChanged(event: EventType, deps: HandlerDeps): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "FolderEntryXmlChanged") return ok([]);

  const { config, logger } = deps;
  const folderDataDir = event.parent;
  const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
  const parentDataDir = dirname(normalizedDir);
  const parentRelativePath = relative(config.dataPath, parentDataDir);

  logger.info("FolderEntryXmlChanged", "Triggering folder-meta-sync for current and parent");

  const events: EventType[] = [{ _tag: "FolderMetaSyncRequested", path: normalizedDir }];

  if (parentDataDir === config.dataPath || parentRelativePath === ".") {
    events.push({ _tag: "FolderMetaSyncRequested", path: config.dataPath });
  } else {
    events.push({ _tag: "FolderMetaSyncRequested", path: parentDataDir });
  }

  return ok(events);
}
