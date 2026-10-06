import { dirname, basename, join, relative, extname } from "node:path";
import { ok, err, type Result } from "neverthrow";
import type { HandlerDeps } from "../../context.ts";
import { AUDIO_EXTENSIONS } from "../../types.ts";
import type { EventType } from "../types.ts";
import { prepareMirrorKind } from "./mirror-kind.ts";
import { readSourceEntry } from "./source-kind.ts";

export async function sourcePathSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "SourcePathSyncRequested") return ok([]);
  const parent = dirname(event.path);
  const name = basename(event.path);

  try {
    const current = await readSourceEntry(event.path, deps.config.filesPath, deps.fs);

    if (current.kind === "missing") {
      return ok([{ _tag: event.isDirectory ? "FolderDeleted" : "AudioFileDeleted", parent, name }]);
    }

    if (current.kind !== "directory") {
      return ok([
        { _tag: current.kind === "audio" ? "AudioFileCreated" : "FolderDeleted", parent, name },
      ]);
    }

    const dataDir = join(deps.config.dataPath, relative(deps.config.filesPath, event.path));
    await prepareMirrorKind(dataDir, true, deps.fs);
    const names = new Set(await deps.fs.readdir(event.path));
    const cachedNames = new Set<string>();

    try {
      for (const child of await deps.fs.readdir(dataDir)) {
        if ((await deps.fs.stat(join(dataDir, child))).isDirectory()) {
          names.add(child);
          cachedNames.add(child);
        }
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
