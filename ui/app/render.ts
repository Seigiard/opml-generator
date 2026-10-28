import { renderCopyOpml, renderSubscribe } from "./subscribe.ts";
import { cloneTemplate, slot } from "./template.ts";
import type { Podcast, PodcastList } from "./parse-feed.ts";

export function renderPodcastList(
  document: Document,
  model: PodcastList,
  origin: string,
  opmlUrl?: string,
): HTMLElement {
  const main = cloneTemplate(document, "tpl-podcast-list");
  const heading = slot(main, "title");
  heading.textContent = model.title;

  if (opmlUrl !== undefined) {
    heading.after(renderCopyOpml(document, opmlUrl, navigatorFor(document)));
  }

  const list = slot(main, "podcasts");

  for (const podcast of model.podcasts) {
    const item = cloneTemplate(document, "tpl-podcast-item");

    fillOrRemove(slot(item, "cover"), podcast.imageUrl || undefined, (cover, imageUrl) => {
      cover.setAttribute("src", imageUrl);
    });

    const title = slot(item, "title");
    title.setAttribute("href", browserPathFor(podcast.xmlUrl, origin));
    title.textContent = podcast.title;

    fillText(slot(item, "author"), podcast.author);
    fillText(slot(item, "description"), podcast.description);

    const subscribe = slot(item, "subscribe");

    if (!model.navigation || podcast.kind === "podcast") {
      const feedUrl = new URL(podcast.xmlUrl, origin).href;
      subscribe.replaceWith(renderSubscribe(document, feedUrl, navigatorFor(document)));
    } else {
      subscribe.remove();
    }

    list.appendChild(item);
  }

  return main;
}

export function renderPodcast(document: Document, model: Podcast, feedUrl: string): HTMLElement {
  const main = cloneTemplate(document, "tpl-podcast-page");

  fillOrRemove(slot(main, "cover"), model.imageUrl || undefined, (cover, imageUrl) => {
    cover.setAttribute("src", imageUrl);
  });

  slot(main, "title").textContent = model.title;
  fillText(slot(main, "author"), model.author);
  fillText(slot(main, "description"), model.description);
  slot(main, "subscribe").replaceWith(renderSubscribe(document, feedUrl, navigatorFor(document)));

  const episodes = slot(main, "episodes");

  for (const episode of model.episodes) {
    const item = cloneTemplate(document, "tpl-episode-item");

    const episodeTitle = slot(item, "title");
    episodeTitle.setAttribute("href", episode.enclosureUrl);
    episodeTitle.textContent = episode.title;

    fillText(
      slot(item, "duration"),
      episode.duration === undefined ? undefined : formatDuration(episode.duration),
    );

    episodes.appendChild(item);
  }

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

function fillText(element: HTMLElement, text: string | undefined): void {
  fillOrRemove(element, text, (target, value) => {
    target.textContent = value;
  });
}

function fillOrRemove(
  element: HTMLElement,
  value: string | undefined,
  fill: (element: HTMLElement, value: string) => void,
): void {
  if (value === undefined) {
    element.remove();
  } else {
    fill(element, value);
  }
}
