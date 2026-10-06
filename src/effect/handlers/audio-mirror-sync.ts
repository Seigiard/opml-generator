import { err, ok, type Result } from "neverthrow";
import { dirname, join, relative } from "node:path";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { assertCachePath } from "../../cache-boundary.ts";
import { cacheFileSystem } from "../../stopping.ts";
import { readSourceEntry } from "./source-kind.ts";
import { prepareMirrorKind } from "./mirror-kind.ts";
import { cachePath } from "../../cache-projection.ts";

export async function audioMirrorSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "AudioMirrorSyncRequested") return ok([]);

  try {
    const source = join(event.parent, event.name);

    const dataDir = assertCachePath(
      cachePath(deps.config.dataPath, relative(deps.config.filesPath, source)),
      deps.config.dataPath,
      false,
    );

    const entry = await readSourceEntry(source, deps.config.filesPath, deps.fs);

    if (entry.kind !== "audio")
      return ok([
        { _tag: "SourcePathSyncRequested", path: source, isDirectory: entry.kind === "directory" },
      ]);
    await prepareMirrorKind(dataDir, false, cacheFileSystem(deps));

    return ok([{ _tag: "FolderMetaSyncRequested", path: dirname(dataDir) }]);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
