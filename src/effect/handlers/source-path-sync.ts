import { dirname, basename, join, relative, extname } from "node:path";
import { ok, err, type Result } from "neverthrow";
import type { HandlerDeps } from "../../context.ts";
import { AUDIO_EXTENSIONS } from "../../types.ts";
import type { EventType } from "../types.ts";
import { prepareMirrorKind } from "./mirror-kind.ts";
import { readSourceEntry } from "./source-kind.ts";
import { assertCachePath } from "../../cache-boundary.ts";
import { cacheFileSystem } from "../../stopping.ts";
import { cachePath } from "../../cache-projection.ts";
import { cacheMirrors } from "../../cache-mirrors.ts";

export async function sourcePathSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "SourcePathSyncRequested") return ok([]);
  const parent = dirname(event.path);
  const name = basename(event.path);

  try {
    const dataDir = assertCachePath(
      cachePath(deps.config.dataPath, relative(deps.config.filesPath, event.path)),
      deps.config.dataPath,
    );

    const current = await readSourceEntry(event.path, deps.config.filesPath, deps.fs);

    if (relative(deps.config.filesPath, event.path) === "" && current.kind !== "directory")
      throw new Error("Source root must be a regular directory");

    if (current.kind === "missing") {
      return ok([{ _tag: event.isDirectory ? "FolderDeleted" : "AudioFileDeleted", parent, name }]);
    }

    if (current.kind !== "directory") {
      return ok([
        { _tag: current.kind === "audio" ? "AudioFileCreated" : "FolderDeleted", parent, name },
      ]);
    }

    await prepareMirrorKind(dataDir, true, cacheFileSystem(deps));
    const names = new Set(await deps.fs.readdir(event.path));
    const cachedNames = new Set<string>();

    try {
      for (const child of await cacheMirrors(dataDir, deps.config.dataPath, deps.fs)) {
        names.add(child.name);
        cachedNames.add(child.name);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const cascades: EventType[] = [];

    for (const child of names) {
      const path = join(event.path, child);
      const entry = await readSourceEntry(path, deps.config.filesPath, deps.fs);

      const isDirectory =
        entry.kind === "directory" ||
        (entry.kind === "missing" &&
          !AUDIO_EXTENSIONS.includes(extname(child).slice(1).toLowerCase()));

      if (cachedNames.has(child) || isDirectory || entry.kind === "audio") {
        cascades.push({ _tag: "SourcePathSyncRequested", path, isDirectory });
      }
    }

    cascades.push({ _tag: "FolderMetaSyncRequested", path: dataDir });

    return ok(cascades);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
