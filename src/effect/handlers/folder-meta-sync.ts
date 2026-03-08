import { Effect } from "effect";
import { join, relative, dirname } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { generatePodcastRss } from "../../rss/podcast-rss.ts";
import type { EpisodeInfo, PodcastInfo } from "../../rss/types.ts";
import { encodeUrlPath, naturalSort, normalizeFilenameTitle } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, ENTRY_FILE, FOLDER_ENTRY_FILE, COVER_FILE } from "../../constants.ts";

const xmlParser = new XMLParser();
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

export const folderMetaSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "FolderMetaSyncRequested") return [];
    const folderDataDir = event.path;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const normalizedDir = folderDataDir.endsWith("/") ? folderDataDir.slice(0, -1) : folderDataDir;
    const relativePath = relative(config.dataPath, normalizedDir);

    if (relativePath !== "") {
      const sourceFolder = join(config.filesPath, relativePath);
      const sourceFolderExists = yield* fs.stat(sourceFolder).pipe(
        Effect.map((s) => s.isDirectory()),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (!sourceFolderExists) {
        yield* logger.debug("FolderMetaSync", "Skipping (source folder deleted)", { path: relativePath });
        return [];
      }
    }

    yield* logger.info("FolderMetaSync", "Processing", { path: relativePath || "(root)" });

    const feedOutputPath = join(normalizedDir, FEED_FILE);

    const feedExistedBefore = yield* fs.exists(feedOutputPath);

    const { episodes, folders } = yield* Effect.tryPromise({
      try: () => collectChildren(normalizedDir),
      catch: (e) => e as Error,
    }).pipe(Effect.catchAll(() => Effect.succeed({ episodes: [] as ParsedEpisode[], folders: [] as FolderChild[] })));

    const hasEpisodes = episodes.length > 0;
    const hasFolders = folders.length > 0;

    if (!hasEpisodes && !hasFolders && feedExistedBefore) {
      yield* fs.rm(feedOutputPath).pipe(Effect.catchAll(() => Effect.void));
      yield* logger.info("FolderMetaSync", "Deleted empty feed.xml", { path: relativePath || "/" });

      if (relativePath !== "") {
        const entryOutputPath = join(normalizedDir, FOLDER_ENTRY_FILE);
        const entryExists = yield* fs.exists(entryOutputPath);
        if (entryExists) {
          yield* fs.rm(entryOutputPath).pipe(Effect.catchAll(() => Effect.void));
        }
      }

      return [{ _tag: "FeedXmlDeleted" as const, path: normalizedDir }];
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
      const podcastAuthor = parentRelativePath !== "." ? parentRelativePath.split("/").pop() : undefined;

      const coverUrl = yield* fs
        .exists(join(normalizedDir, COVER_FILE))
        .pipe(Effect.map((exists) => (exists ? `/${encodeUrlPath(relativePath)}/${COVER_FILE}` : undefined)));

      const podcastInfo: PodcastInfo = {
        title: podcastTitle,
        author: podcastAuthor,
        imageUrl: coverUrl,
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
      yield* fs.atomicWrite(feedOutputPath, rssXml);
    } else if (hasFolders) {
      const rawFolderName = relativePath.split("/").pop() || "Catalog";
      const folderName = rawFolderName === "Catalog" ? rawFolderName : normalizeFilenameTitle(rawFolderName);

      const navigationXml = buildNavigationFeed(folderName, relativePath, folders);
      yield* fs.atomicWrite(feedOutputPath, navigationXml);
    }

    yield* logger.info("FolderMetaSync", "Generated feed.xml", {
      path: relativePath || "/",
      episodes: episodes.length,
      subfolders: folders.length,
    });

    if (relativePath !== "") {
      const entryOutputPath = join(normalizedDir, FOLDER_ENTRY_FILE);
      const rawFolderName = relativePath.split("/").pop() || "";
      const folderName = normalizeFilenameTitle(rawFolderName);
      const selfHref = `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;

      const folderEntryXml = xmlBuilder.build({
        "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
        folder: {
          title: folderName,
          href: selfHref,
          feedCount: episodes.length + folders.length,
        },
      }) as string;

      const existingContent = yield* Effect.tryPromise({
        try: async () => {
          const file = Bun.file(entryOutputPath);
          return (await file.exists()) ? await file.text() : null;
        },
        catch: () => null as never,
      }).pipe(Effect.catchAll(() => Effect.succeed(null as string | null)));

      if (existingContent !== folderEntryXml) {
        yield* fs.atomicWrite(entryOutputPath, folderEntryXml);
        yield* logger.debug("FolderMetaSync", "Updated _entry.xml", { path: relativePath });
      }
    }

    const cascades: EventType[] = [];
    if (!feedExistedBefore && (hasEpisodes || hasFolders)) {
      cascades.push({ _tag: "FeedXmlCreated", path: normalizedDir });
    }

    return cascades;
  });

async function collectChildren(dir: string): Promise<{ episodes: ParsedEpisode[]; folders: FolderChild[] }> {
  const episodes: ParsedEpisode[] = [];
  const folders: FolderChild[] = [];

  const items = await readdir(dir);

  for (const item of items) {
    if (item.startsWith("_")) continue;
    if (item === FEED_FILE || item.endsWith(".tmp")) continue;

    const itemPath = join(dir, item);
    const itemStat = await stat(itemPath);

    if (!itemStat.isDirectory()) continue;

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
      if (parsed) folders.push(parsed);
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

  return xmlBuilder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    feed: {
      title,
      link: relativePath === "" ? `/${FEED_FILE}` : `/${encodeUrlPath(relativePath)}/${FEED_FILE}`,
      item: items,
    },
  }) as string;
}
