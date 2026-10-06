import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { join, relative } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { generateOpml } from "../../rss/opml.ts";
import { encodeUrlPath } from "../../utils/processor.ts";
import type { HandlerDeps, FileSystemService } from "../../context.ts";
import type { EventType } from "../types.ts";
import { FEED_FILE, OPML_FILE } from "../../constants.ts";
import type { OpmlOutline } from "../../rss/types.ts";
import { z } from "zod";
import { filesystemIdentity } from "../../stopping.ts";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  attributeNamePrefix: "@_",
});

interface DiscoveredFeed {
  title: string;
  feedUrl: string;
  author?: string;
  imageUrl?: string;
  description?: string;
}

const optionalText = z.string().optional().catch(undefined);

const podcastFeedSchema = z.object({
  rss: z.object({
    channel: z.object({
      title: z.string().min(1),
      "itunes:author": optionalText,
      "itunes:image": z.object({ "@_href": optionalText }).optional().catch(undefined),
      description: optionalText,
    }),
  }),
});

const navigationFeedSchema = z.object({ feed: z.object({ title: z.string() }) });

const absentPathError = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

async function collectPodcastFeeds(
  dataRoot: string,
  fs: FileSystemService,
): Promise<DiscoveredFeed[]> {
  const feeds: DiscoveredFeed[] = [];
  await walkDirectory(dataRoot, dataRoot, feeds, fs);

  return feeds;
}

async function walkDirectory(
  dir: string,
  dataRoot: string,
  feeds: DiscoveredFeed[],
  fs: FileSystemService,
): Promise<void> {
  let items: string[];

  try {
    items = await fs.readdir(dir);
  } catch (error) {
    if (absentPathError.safeParse(error).success) return;
    throw error;
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
    } catch (error) {
      if (absentPathError.safeParse(error).success) continue;
      throw error;
    }
  }
}

async function parsePodcastFeed(
  feedPath: string,
  feedDir: string,
  dataRoot: string,
): Promise<DiscoveredFeed | null> {
  try {
    const content = await Bun.file(feedPath).text();

    if (XMLValidator.validate(content) !== true) throw new Error(`Invalid feed XML: ${feedPath}`);
    const document: unknown = xmlParser.parse(content);

    if (navigationFeedSchema.safeParse(document).success) return null;
    const parsed = podcastFeedSchema.parse(document);

    const channel = parsed?.rss?.channel;
    const channelTitle = channel?.title;

    if (!channelTitle) return null;

    const relativePath = relative(dataRoot, feedDir);
    const feedUrl = `/${encodeUrlPath(join(relativePath, FEED_FILE))}`;

    const feed: DiscoveredFeed = { title: String(channelTitle), feedUrl };

    const author = channel["itunes:author"];

    if (author) {
      feed.author = author;
    }

    const imageHref = channel["itunes:image"]?.["@_href"];

    if (imageHref) {
      feed.imageUrl = imageHref;
    }

    const description = channel.description;

    if (description) {
      feed.description = description;
    }

    return feed;
  } catch (error) {
    if (absentPathError.safeParse(error).success) return null;
    throw error;
  }
}

const pendingPublications = new WeakMap<FileSystemService, Promise<void>>();

export async function withPublicationLock<T>(
  fs: FileSystemService,
  operation: () => Promise<T>,
): Promise<T> {
  fs = filesystemIdentity(fs);
  const previous = pendingPublications.get(fs);
  let release!: () => void;

  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  pendingPublications.set(fs, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (pendingPublications.get(fs) === current) pendingPublications.delete(fs);
  }
}

export async function opmlSync(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  if (
    event._tag !== "FeedXmlCreated" &&
    event._tag !== "FeedXmlDeleted" &&
    event._tag !== "FeedXmlChanged"
  )
    return ok([]);

  const publication = withPublicationLock(deps.fs, () => publishOpml(event, deps));
  deps.logger.debug("OpmlSync", "Publication requested", { trigger: event._tag });

  return publication;
}

async function publishOpml(
  event: EventType,
  deps: HandlerDeps,
): Promise<Result<readonly EventType[], Error>> {
  const { config, logger, fs } = deps;

  logger.info("OpmlSync", "Regenerating OPML", { trigger: event._tag });

  let feeds: DiscoveredFeed[];

  try {
    feeds = await collectPodcastFeeds(config.dataPath, fs);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }

  feeds.sort((a, b) => a.title.localeCompare(b.title));

  const outlines: OpmlOutline[] = feeds.map((f) => ({
    title: f.title,
    feedUrl: f.feedUrl,
    author: f.author,
    imageUrl: f.imageUrl,
    description: f.description,
  }));

  const opmlXml = generateOpml("Audiobooks", outlines);
  const opmlPath = join(config.dataPath, OPML_FILE);

  try {
    await fs.atomicWrite(opmlPath, opmlXml);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }

  logger.info("OpmlSync", "OPML generated", { feeds: feeds.length });

  return ok([]);
}
