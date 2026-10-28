import { parseFeed, parseOpml } from "./parse-feed.ts";
import { feedUrlFor, pagePathFor } from "./routes.ts";

export type Page =
  | { kind: "building"; retryAfterMs: number }
  | { kind: "not-found" }
  | { kind: "error"; message: string; feedUrl: string }
  | { kind: "list"; title: string; opmlUrl?: string; entries: ListEntry[] }
  | {
      kind: "podcast";
      title: string;
      author?: string;
      description?: string;
      imageUrl?: string;
      subscribeUrl: string;
      episodes: Episode[];
    };

interface ListEntry {
  title: string;
  href: string;
  author?: string;
  description?: string;
  imageUrl?: string;
  subscribeUrl?: string;
}

interface Episode {
  title: string;
  href: string;
  duration?: number;
}

export async function loadPage(
  pathname: string,
  origin: string,
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<Page> {
  const route = feedUrlFor(pathname);

  if (route === null) return { kind: "not-found" };

  try {
    const response = await fetch(route.feedUrl, { signal });

    if (response.status === 503) {
      return { kind: "building", retryAfterMs: retryDelay(response) };
    }

    if (response.status === 404) return { kind: "not-found" };

    if (!response.ok) {
      return {
        kind: "error",
        message: response.statusText || `HTTP ${response.status}`,
        feedUrl: route.feedUrl,
      };
    }

    const text = await response.text();

    if (route.kind === "list") {
      const model = parseOpml(text);

      return {
        kind: "list",
        title: model.title,
        opmlUrl: new URL(route.feedUrl, origin).href,
        entries: model.podcasts.map((podcast) => listEntryFor(podcast, origin, true)),
      };
    }

    const feed = parseFeed(text);

    if (feed.kind === "navigation") {
      return {
        kind: "list",
        title: feed.model.title,
        entries: feed.model.podcasts.map((podcast) =>
          listEntryFor(podcast, origin, podcast.kind === "podcast"),
        ),
      };
    }

    const page: Extract<Page, { kind: "podcast" }> = {
      kind: "podcast",
      title: feed.model.title,
      subscribeUrl: new URL(route.feedUrl, origin).href,
      episodes: feed.model.episodes.map((episode) => episodeFor(episode)),
    };

    if (feed.model.author !== undefined) page.author = feed.model.author;

    if (feed.model.description !== undefined) page.description = feed.model.description;

    if (feed.model.imageUrl) page.imageUrl = feed.model.imageUrl;

    return page;
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Could not load feed",
      feedUrl: route.feedUrl,
    };
  }
}

function listEntryFor(
  podcast: {
    title: string;
    xmlUrl: string;
    author?: string;
    description?: string;
    imageUrl?: string;
  },
  origin: string,
  subscribe: boolean,
): ListEntry {
  const entry: ListEntry = {
    title: podcast.title,
    href: pagePathFor(podcast.xmlUrl, origin),
  };

  if (podcast.author !== undefined) entry.author = podcast.author;

  if (podcast.description !== undefined) entry.description = podcast.description;

  if (podcast.imageUrl) entry.imageUrl = podcast.imageUrl;

  if (subscribe) entry.subscribeUrl = new URL(podcast.xmlUrl, origin).href;

  return entry;
}

function episodeFor(episode: { title: string; enclosureUrl: string; duration?: number }): Episode {
  const result: Episode = { title: episode.title, href: episode.enclosureUrl };

  if (episode.duration !== undefined) result.duration = episode.duration;

  return result;
}

function retryDelay(response: Response): number {
  const value = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);

  return Number.isFinite(value) && value >= 0 ? value * 1000 : 5000;
}
