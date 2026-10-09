import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, relative, dirname, basename } from "node:path";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { generatePodcastRss } from "../../rss/podcast-rss.ts";
import type { EpisodeInfo, PodcastInfo } from "../../rss/types.ts";
import { encodeUrlPath, naturalSort, normalizeFilenameTitle } from "../../utils/processor.ts";
import type { HandlerDeps, FileSystemService } from "../../context.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, ENTRY_FILE, FOLDER_ENTRY_FILE, COVER_FILE } from "../../constants.ts";
import { readSourceEntry } from "./source-kind.ts";
import { assertCachePath, cacheParent } from "../../cache-boundary.ts";
import { cacheFileSystem } from "../../stopping.ts";
import { decodeRelative } from "../../cache-projection.ts";
import { cacheMirrors } from "../../cache-mirrors.ts";

const xmlParser = new XMLParser({ parseTagValue: false });

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

interface ParsedEpisode {
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

function parseEntryXml(content: string): ParsedEpisode | null {
  try {
    const parsed = xmlParser.parse(content);
    const ep = parsed?.episode;

    if (!ep) return null;

    return {
      title: String(ep.title ?? ""),
      fileName: String(ep.fileName ?? ""),
      filePath: String(ep.filePath ?? ""),
      fileSize: Number(ep.fileSize ?? 0),
      mimeType: String(ep.mimeType ?? "application/octet-stream"),
      duration: ep.duration != null ? Number(ep.duration) : undefined,
      discNumber: ep.discNumber != null ? Number(ep.discNumber) : undefined,
      trackNumber: ep.trackNumber != null ? Number(ep.trackNumber) : undefined,
      episodeNumber: Number(ep.episodeNumber ?? 0),
      pubDate: String(ep.pubDate ?? ""),
      guid: String(ep.guid ?? ""),
    };
  } catch {
    return null;
  }
}

function sortEpisodes(a: ParsedEpisode, b: ParsedEpisode): number {
  const discA = a.discNumber ?? 0;
  const discB = b.discNumber ?? 0;

  if (discA !== discB) return discA - discB;

  const trackA = a.trackNumber ?? 0;
  const trackB = b.trackNumber ?? 0;

  if (trackA !== trackB) return trackA - trackB;

  return naturalSort(a.fileName, b.fileName);
}

interface FolderChild {
  title: string;
  href: string;
  feedCount: number;
}

function parseFolderEntryXml(content: string): FolderChild | null {
  try {
    const parsed = xmlParser.parse(content);
    const folder = parsed?.folder;

    if (!folder) return null;

    return {
      title: String(folder.title ?? ""),
      href: String(folder.href ?? ""),
      feedCount: Number(folder.feedCount ?? 0),
    };
  } catch {
    return null;
  }
}

export async function folderMetaSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "FolderMetaSyncRequested") return ok([]);

  const folderDataDir = event.path;
  const { config, logger } = deps;
  const fs = cacheFileSystem(deps);

  const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
  const relativePath = decodeRelative(relative(config.dataPath, normalizedDir));
  const sourceFolder = join(config.filesPath, relativePath);

  try {
    assertCachePath(normalizedDir, config.dataPath);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }

  if (relativePath === "") {
    try {
      const root = await readSourceEntry(config.filesPath, config.filesPath, fs);

      if (root.kind !== "directory") throw new Error("Source root must be a regular directory");
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (relativePath !== "") {
    let sourceFolderExists = false;

    try {
      const s = await readSourceEntry(sourceFolder, config.filesPath, fs);
      sourceFolderExists = s.kind === "directory";

      if (s.kind === "audio") {
        return ok([{ _tag: "SourcePathSyncRequested", path: sourceFolder, isDirectory: false }]);
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR")
        )
      )
        return err(error instanceof Error ? error : new Error(String(error)));
    }

    if (!sourceFolderExists) {
      logger.debug("FolderMetaSync", "Skipping (source folder deleted)", { path: relativePath });

      return ok([
        { _tag: "FolderDeleted", parent: dirname(sourceFolder), name: basename(sourceFolder) },
      ]);
    }
  }

  logger.info("FolderMetaSync", "Processing", { path: relativePath || "(root)" });

  try {
    const feedOutputPath = join(normalizedDir, FEED_FILE);
    const feedExistedBefore = await fs.exists(feedOutputPath);

    let episodes: ParsedEpisode[];
    let folders: FolderChild[];

    try {
      const children = await collectChildren(normalizedDir, config.dataPath, fs);
      episodes = children.episodes;
      folders = children.folders;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      episodes = [];
      folders = [];
    }

    const hasEpisodes = episodes.length > 0;
    const hasFolders = folders.length > 0;

    if (!hasEpisodes && !hasFolders) {
      if (relativePath === "") {
        if (feedExistedBefore) await fs.rm(feedOutputPath);
      } else if (!(await containsSourceAudio(sourceFolder, config.filesPath, fs))) {
        try {
          await fs.rm(normalizedDir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      } else {
        if (feedExistedBefore) await fs.rm(feedOutputPath);
        const entryOutputPath = join(normalizedDir, FOLDER_ENTRY_FILE);

        if (await fs.exists(entryOutputPath)) await fs.rm(entryOutputPath);
      }

      const cascades: EventType[] = [];

      if (relativePath !== "")
        cascades.unshift({
          _tag: "FolderMetaSyncRequested",
          path: cacheParent(normalizedDir, config.dataPath)!,
        });

      return ok(cascades);
    }

    if (hasEpisodes) {
      episodes.sort(sortEpisodes);

      const rawFolderName = relativePath.split("/").pop() || "Catalog";
      const firstEpisode = episodes[0]!;

      const podcastTitle = firstEpisode.title
        ? episodes.length > 1
          ? normalizeFilenameTitle(rawFolderName)
          : firstEpisode.title
        : normalizeFilenameTitle(rawFolderName);

      const parentRelativePath = dirname(relativePath);

      const podcastAuthor =
        parentRelativePath !== "." ? parentRelativePath.split("/").pop() : undefined;

      const coverExists = await fs.exists(join(normalizedDir, COVER_FILE));

      const coverUrl = coverExists
        ? `/${encodeUrlPath(join(relativePath, COVER_FILE))}`
        : undefined;

      const selfUrl = `/${encodeUrlPath(join(relativePath, FEED_FILE))}`;

      const podcastInfo: PodcastInfo = {
        title: podcastTitle,
        author: podcastAuthor,
        imageUrl: coverUrl,
        selfUrl,
      };

      const episodeInfos: EpisodeInfo[] = episodes.map((ep, index) => ({
        title: ep.title,
        guid: ep.guid,
        pubDate: ep.pubDate,
        enclosureUrl: encodeUrlPath(join(config.filesPath, ep.filePath)),
        enclosureLength: ep.fileSize,
        enclosureType: ep.mimeType,
        duration: ep.duration,
        episodeNumber: index + 1,
      }));

      const rssXml = generatePodcastRss(podcastInfo, episodeInfos);
      await fs.atomicWrite(feedOutputPath, rssXml);
    } else if (hasFolders) {
      const rawFolderName = relativePath.split("/").pop() || "Catalog";

      const folderName =
        rawFolderName === "Catalog" ? rawFolderName : normalizeFilenameTitle(rawFolderName);

      const navigationXml = buildNavigationFeed(folderName, relativePath, folders);
      await fs.atomicWrite(feedOutputPath, navigationXml);
    }

    logger.info("FolderMetaSync", "Generated feed.xml", {
      path: relativePath || "/",
      episodes: episodes.length,
      subfolders: folders.length,
    });

    if (relativePath !== "") {
      const entryOutputPath = join(normalizedDir, FOLDER_ENTRY_FILE);
      const rawFolderName = relativePath.split("/").pop() || "";
      const folderName = normalizeFilenameTitle(rawFolderName);
      const selfHref = `/${encodeUrlPath(join(relativePath, FEED_FILE))}`;

      // SAFETY: XMLBuilder.build returns XML text with this builder configuration.
      const folderEntryXml = xmlBuilder.build({
        "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
        folder: {
          title: folderName,
          href: selfHref,
          feedCount: episodes.length + folders.length,
        },
      }) as string;

      let existingContent: string | null = null;

      try {
        const file = Bun.file(entryOutputPath);
        existingContent = (await file.exists()) ? await file.text() : null;
      } catch {
        existingContent = null;
      }

      if (existingContent !== folderEntryXml) {
        await fs.atomicWrite(entryOutputPath, folderEntryXml);
        logger.debug("FolderMetaSync", "Updated _entry.xml", { path: relativePath });
      }
    }

    const cascades: EventType[] = [];

    if (relativePath !== "") {
      cascades.push({
        _tag: "FolderMetaSyncRequested",
        path: cacheParent(normalizedDir, config.dataPath)!,
      });
    }

    return ok(cascades);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

async function containsSourceAudio(
  dir: string,
  root: string,
  fs: FileSystemService,
): Promise<boolean> {
  for (const name of await fs.readdir(dir)) {
    const path = join(dir, name);
    const current = await readSourceEntry(path, root, fs);

    if (current.kind === "directory") {
      if (await containsSourceAudio(path, root, fs)) return true;
    } else if (current.kind === "audio") {
      return true;
    }
  }

  return false;
}

async function collectChildren(
  dir: string,
  root: string,
  fs: FileSystemService,
): Promise<{ episodes: ParsedEpisode[]; folders: FolderChild[] }> {
  const episodes: ParsedEpisode[] = [];
  const folders: FolderChild[] = [];

  for (const { path: itemPath } of await cacheMirrors(dir, root, fs)) {
    const episodeEntryPath = join(itemPath, ENTRY_FILE);
    const folderEntryPath = join(itemPath, FOLDER_ENTRY_FILE);

    const episodeFile = Bun.file(episodeEntryPath);
    const folderFile = Bun.file(folderEntryPath);

    if (await episodeFile.exists()) {
      const content = await episodeFile.text();
      const parsed = parseEntryXml(content);

      if (parsed) episodes.push(parsed);
    } else if (await folderFile.exists()) {
      const content = await folderFile.text();
      const parsed = parseFolderEntryXml(content);

      if (parsed && parsed.feedCount > 0) folders.push(parsed);
    }
  }

  return { episodes, folders };
}

function buildNavigationFeed(title: string, relativePath: string, folders: FolderChild[]): string {
  folders.sort((a, b) => naturalSort(a.title, b.title));

  const items = folders.map((f) => ({
    title: f.title,
    link: f.href,
    description: `${f.feedCount} items`,
  }));

  // SAFETY: XMLBuilder.build returns XML text with this builder configuration.
  return xmlBuilder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    feed: {
      title,
      link: relativePath === "" ? `/${FEED_FILE}` : `/${encodeUrlPath(relativePath)}/${FEED_FILE}`,
      item: items,
    },
  }) as string;
}
