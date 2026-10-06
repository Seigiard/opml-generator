import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, basename, dirname, relative, extname } from "node:path";
import { XMLBuilder } from "fast-xml-parser";
import { MIME_TYPES } from "../../types.ts";
import type { AudioMetadata } from "../../audio/types.ts";
import { readAudioMetadata, extractEmbeddedCover } from "../../audio/id3-reader.ts";
import { findFolderCover } from "../../audio/cover.ts";
import { saveBufferAsImage, COVER_MAX_SIZE } from "../../utils/image.ts";
import type { HandlerDeps, FileSystemService } from "../../context.ts";
import type { EventType } from "../types.ts";
import { ENTRY_FILE, COVER_FILE } from "../../constants.ts";
import { checkFileSystemAccess, cacheFileSystem } from "../../stopping.ts";
import { checkCacheMutation } from "../../cache-boundary.ts";
import { prepareMirrorKind } from "./mirror-kind.ts";
import { readSourceEntry } from "./source-kind.ts";
import { assertCachePath } from "../../cache-boundary.ts";
import { cachePath } from "../../cache-projection.ts";

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

interface EpisodeFields {
  title: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  duration?: number;
  discNumber?: number;
  trackNumber?: number;
  episodeNumber: number;
  pubDate: string;
  guid: string;
}

function buildEpisodeXml(fields: EpisodeFields): string {
  // SAFETY: XMLBuilder.build returns XML text with the configured string builder.
  return xmlBuilder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    episode: fields,
  }) as string;
}

export async function audioSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "AudioFileCreated") return ok([]);

  const { parent, name } = event;
  const { config, logger } = deps;
  const fs = cacheFileSystem(deps);

  const ext = extname(name).slice(1).toLowerCase();
  const filePath = join(parent, name);
  const relativePath = relative(config.filesPath, filePath);
  const episodeDataDir = cachePath(config.dataPath, relativePath);
  const folderDataDir = dirname(episodeDataDir);

  logger.info("AudioSync", "Processing", { path: relativePath });

  try {
    assertCachePath(episodeDataDir, config.dataPath, false);
    const fileStat = await readSourceEntry(filePath, config.filesPath, fs);

    if (fileStat.kind !== "audio") {
      return ok([
        {
          _tag: "SourcePathSyncRequested",
          path: filePath,
          isDirectory: fileStat.kind === "directory",
        },
      ]);
    }

    await prepareMirrorKind(episodeDataDir, false, fs);
    await fs.mkdir(episodeDataDir, { recursive: true });

    let metadata: AudioMetadata;

    try {
      metadata = await readAudioMetadata(filePath);
    } catch {
      metadata = { title: basename(name, extname(name)) };
    }

    const episodeNumber = await resolveEpisodeNumber(folderDataDir, episodeDataDir, fs);
    const pubDate = await resolvePubDate(metadata.date, folderDataDir, episodeNumber, fs);
    const mimeType = MIME_TYPES.get(ext) ?? "application/octet-stream";

    const episodeXml = buildEpisodeXml({
      title: metadata.title,
      fileName: name,
      filePath: relativePath,
      fileSize: fileStat.size,
      mimeType,
      ...(metadata.duration != null && { duration: Math.floor(metadata.duration) }),
      ...(metadata.discNumber != null && { discNumber: metadata.discNumber }),
      ...(metadata.trackNumber != null && { trackNumber: metadata.trackNumber }),
      episodeNumber,
      pubDate,
      guid: relativePath,
    });

    await fs.atomicWrite(join(episodeDataDir, ENTRY_FILE), episodeXml);
    await handleFolderCover(filePath, parent, folderDataDir, config.dataPath, fs);

    logger.info("AudioSync", "Done", { path: relativePath, episode: episodeNumber });

    return ok([{ _tag: "FolderMetaSyncRequested", path: folderDataDir }]);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

async function resolveEpisodeNumber(
  folderDataDir: string,
  currentEpisodeDir: string,
  fs: FileSystemService,
): Promise<number> {
  let siblings: string[];

  try {
    siblings = await fs.readdir(folderDataDir);
  } catch {
    return 1;
  }

  let maxEpisode = 0;

  for (const sibling of siblings) {
    const siblingDir = join(folderDataDir, sibling);

    if (siblingDir === currentEpisodeDir) continue;

    const entryPath = join(siblingDir, ENTRY_FILE);
    const exists = await fs.exists(entryPath);

    if (!exists) continue;

    let content: string;

    try {
      content = await Bun.file(entryPath).text();
    } catch {
      continue;
    }

    const match = content.match(/<episodeNumber>(\d+)<\/episodeNumber>/);

    if (match) {
      maxEpisode = Math.max(maxEpisode, Number.parseInt(match[1]!, 10));
    }
  }

  return maxEpisode + 1;
}

async function resolvePubDate(
  id3Date: string | undefined,
  folderDataDir: string,
  episodeNumber: number,
  fs: FileSystemService,
): Promise<string> {
  if (id3Date) {
    const parsed = new Date(id3Date);

    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  let siblings: string[];

  try {
    siblings = await fs.readdir(folderDataDir);
  } catch {
    siblings = [];
  }

  let earliestMtime = Date.now();

  for (const sibling of siblings) {
    const siblingDir = join(folderDataDir, sibling);
    const entryPath = join(siblingDir, ENTRY_FILE);
    const exists = await fs.exists(entryPath);

    if (!exists) continue;

    let content: string;

    try {
      content = await Bun.file(entryPath).text();
    } catch {
      continue;
    }

    const match = content.match(/<pubDate>([^<]+)<\/pubDate>/);

    if (match) {
      const parsed = new Date(match[1]!);

      if (!Number.isNaN(parsed.getTime())) {
        earliestMtime = Math.min(earliestMtime, parsed.getTime());
      }
    }
  }

  const baseDate = new Date(earliestMtime);
  const synthesized = new Date(baseDate.getTime() + (episodeNumber - 1) * 60_000);

  return synthesized.toISOString();
}

async function handleFolderCover(
  audioFilePath: string,
  sourceFolder: string,
  folderDataDir: string,
  dataPath: string,
  fs: FileSystemService,
): Promise<void> {
  try {
    const coverPath = join(folderDataDir, COVER_FILE);
    const coverExists = await fs.exists(coverPath);

    if (coverExists) return;
    await checkCacheMutation(coverPath, dataPath, fs, true, () => checkFileSystemAccess(fs));

    let folderCoverPath: string | null = null;

    try {
      folderCoverPath = await findFolderCover(sourceFolder);
    } catch {
      folderCoverPath = null;
    }

    if (folderCoverPath) {
      try {
        const coverBuffer = Buffer.from(await Bun.file(folderCoverPath).arrayBuffer());
        await saveBufferAsImage(coverBuffer, coverPath, COVER_MAX_SIZE, async () => {
          checkFileSystemAccess(fs);
          await checkCacheMutation(coverPath, dataPath, fs, true, () => checkFileSystemAccess(fs));
        });

        return;
      } catch {
        // fall through to embedded cover
      }
    }

    let embeddedCover: { data: Buffer } | null = null;

    try {
      embeddedCover = await extractEmbeddedCover(audioFilePath);
    } catch {
      embeddedCover = null;
    }

    if (embeddedCover) {
      try {
        await saveBufferAsImage(embeddedCover.data, coverPath, COVER_MAX_SIZE, async () => {
          checkFileSystemAccess(fs);
          await checkCacheMutation(coverPath, dataPath, fs, true, () => checkFileSystemAccess(fs));
        });
      } catch {
        // ignore cover save failures
      }
    }
  } catch {
    // handleFolderCover is best-effort
  }
}
