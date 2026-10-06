import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, relative, basename } from "node:path";
import { XMLBuilder } from "fast-xml-parser";
import { encodeUrlPath, normalizeFilenameTitle } from "../../utils/processor.ts";
import type { HandlerDeps } from "../../context.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, FOLDER_ENTRY_FILE } from "../../constants.ts";
import { prepareMirrorKind } from "./mirror-kind.ts";
import { readSourceEntry } from "./source-kind.ts";
import { assertCachePath } from "../../cache-boundary.ts";
import { cacheFileSystem } from "../../stopping.ts";
import { cachePath } from "../../cache-projection.ts";

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

export async function folderSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "FolderCreated") return ok([]);

  const { parent, name } = event;
  const { config, logger } = deps;
  const fs = cacheFileSystem(deps);

  const folderPath = join(parent, name);
  const relativePath = relative(config.filesPath, folderPath);
  const folderDataDir = cachePath(config.dataPath, relativePath);

  logger.info("FolderSync", "Processing", { path: relativePath || "(root)" });

  try {
    assertCachePath(folderDataDir, config.dataPath);
    const source = await readSourceEntry(folderPath, config.filesPath, fs);

    if (relativePath === "" && source.kind !== "directory")
      throw new Error("Source root must be a regular directory");

    if (source.kind !== "directory") {
      return ok([{ _tag: "SourcePathSyncRequested", path: folderPath, isDirectory: true }]);
    }

    await prepareMirrorKind(folderDataDir, true, fs);
    await fs.mkdir(folderDataDir, { recursive: true });

    if (relativePath !== "") {
      const folderName = normalizeFilenameTitle(basename(relativePath));
      const selfHref = `/${encodeUrlPath(join(relativePath, FEED_FILE))}`;

      // SAFETY: XMLBuilder.build returns XML text, not its untyped input object.
      const entryXml = xmlBuilder.build({
        "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
        folder: {
          title: folderName,
          href: selfHref,
          feedCount: 0,
        },
      }) as string;

      await fs.atomicWrite(join(folderDataDir, FOLDER_ENTRY_FILE), entryXml);
      logger.info("FolderSync", "Done", { path: relativePath });
    } else {
      logger.info("FolderSync", "Root folder - no _entry.xml needed");
    }

    return ok([{ _tag: "FolderMetaSyncRequested", path: folderDataDir }] as const);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
