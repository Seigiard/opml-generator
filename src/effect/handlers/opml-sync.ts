import { Effect } from "effect";
import { join, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { generateOpml } from "../../rss/opml.ts";
import { encodeUrlPath } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, OPML_FILE } from "../../constants.ts";
import type { OpmlOutline } from "../../rss/types.ts";

const xmlParser = new XMLParser();

interface DiscoveredFeed {
  title: string;
  feedUrl: string;
}

async function collectPodcastFeeds(dataRoot: string): Promise<DiscoveredFeed[]> {
  const feeds: DiscoveredFeed[] = [];
  await walkDirectory(dataRoot, dataRoot, feeds);
  return feeds;
}

async function walkDirectory(dir: string, dataRoot: string, feeds: DiscoveredFeed[]): Promise<void> {
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return;
  }

  for (const item of items) {
    const itemPath = join(dir, item);

    if (item === FEED_FILE) {
      const feed = await parsePodcastFeed(itemPath, dir, dataRoot);
      if (feed) feeds.push(feed);
      continue;
    }

    try {
      const itemStat = await stat(itemPath);
      if (itemStat.isDirectory()) {
        await walkDirectory(itemPath, dataRoot, feeds);
      }
    } catch {
      continue;
    }
  }
}

async function parsePodcastFeed(feedPath: string, feedDir: string, dataRoot: string): Promise<DiscoveredFeed | null> {
  try {
    const content = await Bun.file(feedPath).text();
    const parsed = xmlParser.parse(content);

    const channelTitle = parsed?.rss?.channel?.title;
    if (!channelTitle) return null;

    const relativePath = relative(dataRoot, feedDir);
    const feedUrl = `/${encodeUrlPath(relativePath)}/${FEED_FILE}`;

    return { title: String(channelTitle), feedUrl };
  } catch {
    return null;
  }
}

export const opmlSync = (event: EventType): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "FeedXmlCreated" && event._tag !== "FeedXmlDeleted") return [];

    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    yield* logger.info("OpmlSync", "Regenerating OPML", { trigger: event._tag });

    const feeds = yield* Effect.tryPromise({
      try: () => collectPodcastFeeds(config.dataPath),
      catch: (e) => e as Error,
    }).pipe(Effect.catchAll(() => Effect.succeed([] as DiscoveredFeed[])));

    feeds.sort((a, b) => a.title.localeCompare(b.title));

    const outlines: OpmlOutline[] = feeds.map((f) => ({
      title: f.title,
      feedUrl: f.feedUrl,
    }));

    const opmlXml = generateOpml("Audiobooks", outlines);
    const opmlPath = join(config.dataPath, OPML_FILE);

    yield* fs.atomicWrite(opmlPath, opmlXml);

    yield* logger.info("OpmlSync", "OPML generated", { feeds: feeds.length });
    return [];
  });
