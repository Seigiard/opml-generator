import { dirname, join } from "node:path";
import type { EventType } from "../types.ts";
import type { SyncPlan } from "../../scanner.ts";

// Parse path into parent and name for events
function parsePath(filesPath: string, relativePath: string): { parent: string; name: string } {
  // Root folder special case: parent is filesPath, name is empty
  if (relativePath === "") {
    return { parent: filesPath + "/", name: "" };
  }
  const fullPath = join(filesPath, relativePath);
  const parent = dirname(fullPath) + "/";
  const name = relativePath.split("/").pop() ?? "";
  return { parent, name };
}

// Adapt sync plan to typed events (no deduplication for initialSync)
export function adaptSyncPlan(plan: SyncPlan, filesPath: string): EventType[] {
  const events: EventType[] = [];

  for (const path of plan.toDelete) {
    const { parent, name } = parsePath(filesPath, path);
    events.push({ _tag: "AudioFileDeleted", parent, name });
  }

  for (const folder of plan.folders) {
    const { parent, name } = parsePath(filesPath, folder.path);
    events.push({ _tag: "FolderCreated", parent, name });
  }

  for (const file of plan.toProcess) {
    const { parent, name } = parsePath(filesPath, file.relativePath);
    events.push({ _tag: "AudioFileCreated", parent, name });
  }

  return events;
}
