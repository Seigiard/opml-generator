import { renderSubscribe } from "./subscribe.ts";
import type { Podcast, PodcastList } from "./parse-feed.ts";

export function renderPodcastList(
  document: Document,
  model: PodcastList,
  origin: string,
): HTMLElement {
  const main = document.createElement("main");
  const heading = document.createElement("h1");
  heading.textContent = model.title;
  main.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "podcasts";

  for (const podcast of model.podcasts) {
    const item = document.createElement("li");
    item.className = "podcast";

    if (podcast.imageUrl) {
      const cover = document.createElement("img");
      cover.className = "podcast__cover";
      cover.src = podcast.imageUrl;
      cover.alt = "";
      item.appendChild(cover);
    }

    const body = document.createElement("div");
    body.className = "podcast__body";

    const title = document.createElement("a");
    title.className = "podcast__title";
    title.href = browserPathFor(podcast.xmlUrl, origin);
    title.textContent = podcast.title;
    body.appendChild(title);

    if (podcast.author !== undefined) {
      const author = document.createElement("small");
      author.className = "podcast__author";
      author.textContent = podcast.author;
      body.appendChild(author);
    }

    if (podcast.description !== undefined) {
      const description = document.createElement("p");
      description.className = "podcast__desc";
      description.textContent = podcast.description;
      body.appendChild(description);
    }

    if (!model.navigation || podcast.kind === "podcast") {
      const feedUrl = new URL(podcast.xmlUrl, origin).href;
      body.appendChild(renderSubscribe(document, feedUrl, navigatorFor(document)));
    }

    item.appendChild(body);
    list.appendChild(item);
  }

  main.appendChild(list);

  return main;
}

export function renderPodcast(document: Document, model: Podcast, feedUrl: string): HTMLElement {
  const main = document.createElement("main");
  const nav = document.createElement("nav");
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = "← Back";
  nav.appendChild(back);
  main.appendChild(nav);

  const header = document.createElement("header");
  header.className = "feed-header";

  if (model.imageUrl) {
    const cover = document.createElement("img");
    cover.className = "feed-header__cover";
    cover.src = model.imageUrl;
    cover.alt = "";
    header.appendChild(cover);
  }

  const info = document.createElement("hgroup");
  info.className = "feed-header__info";

  const title = document.createElement("h1");
  title.className = "feed-header__title";
  title.textContent = model.title;
  info.appendChild(title);

  if (model.author !== undefined) {
    const author = document.createElement("p");
    author.className = "feed-header__author";
    author.textContent = model.author;
    info.appendChild(author);
  }

  if (model.description !== undefined) {
    const description = document.createElement("p");
    description.className = "feed-header__desc";
    description.textContent = model.description;
    info.appendChild(description);
  }

  info.appendChild(renderSubscribe(document, feedUrl, navigatorFor(document)));
  header.appendChild(info);
  main.appendChild(header);

  const episodes = document.createElement("ol");
  episodes.className = "episodes";

  for (const episode of model.episodes) {
    const item = document.createElement("li");
    item.className = "episode";

    const episodeTitle = document.createElement("a");
    episodeTitle.className = "episode__title";
    episodeTitle.href = episode.enclosureUrl;
    episodeTitle.textContent = episode.title;
    item.appendChild(episodeTitle);

    if (episode.duration !== undefined) {
      const duration = document.createElement("small");
      duration.className = "episode__duration";
      duration.textContent = formatDuration(episode.duration);
      item.appendChild(duration);
    }

    episodes.appendChild(item);
  }

  main.appendChild(episodes);

  return main;
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(remainingSeconds)}`;
  }

  return `${minutes}:${pad(remainingSeconds)}`;
}

function browserPathFor(feedUrl: string, origin: string): string {
  const path = new URL(feedUrl, origin).pathname;
  const withoutFeed = path.endsWith("/feed.xml") ? path.slice(0, -"feed.xml".length) : path;
  const pagePath = withoutFeed.endsWith("/") ? withoutFeed : `${withoutFeed}/`;

  return `/browse${pagePath}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function navigatorFor(document: Document): Navigator {
  return document.defaultView?.navigator ?? globalThis.navigator;
}
