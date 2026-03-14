import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, relative } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { generateOpml } from "../../rss/opml.ts";
import { encodeUrlPath } from "../../utils/processor.ts";
import type { HandlerDeps, FileSystemService } from "../../context.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, OPML_FILE } from "../../constants.ts";
import type { OpmlOutline } from "../../rss/types.ts";

const xmlParser = new XMLParser();

interface DiscoveredFeed {
  title: string;
  feedUrl: string;
}

async function collectPodcastFeeds(dataRoot: string, fs: FileSystemService): Promise<DiscoveredFeed[]> {
  const feeds: DiscoveredFeed[] = [];
  await walkDirectory(dataRoot, dataRoot, feeds, fs);
  return feeds;
}

async function walkDirectory(dir: string, dataRoot: string, feeds: DiscoveredFeed[], fs: FileSystemService): Promise<void> {
  let items: string[];
  try {
    items = await fs.readdir(dir);
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
      const itemStat = await fs.stat(itemPath);
      if (itemStat.isDirectory()) {
        await walkDirectory(itemPath, dataRoot, feeds, fs);
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

export async function opmlSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (event._tag !== "FeedXmlCreated" && event._tag !== "FeedXmlDeleted") return ok([]);

  const { config, logger, fs } = deps;

  logger.info("OpmlSync", "Regenerating OPML", { trigger: event._tag });

  let feeds: DiscoveredFeed[];
  try {
    feeds = await collectPodcastFeeds(config.dataPath, fs);
  } catch {
    feeds = [];
  }

  feeds.sort((a, b) => a.title.localeCompare(b.title));

  const outlines: OpmlOutline[] = feeds.map((f) => ({
    title: f.title,
    feedUrl: f.feedUrl,
  }));

  const opmlXml = generateOpml("Audiobooks", outlines);
  const opmlPath = join(config.dataPath, OPML_FILE);

  try {
    await fs.atomicWrite(opmlPath, opmlXml);
  } catch (error) {
    return err(error as Error);
  }

  logger.info("OpmlSync", "OPML generated", { feeds: feeds.length });
  return ok([]);
}
