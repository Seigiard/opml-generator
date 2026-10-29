import { coverPlaceholder } from "./cover-placeholder.ts";
import type { Page } from "./page.ts";
import { renderCopyOpml, renderSubscribe } from "./subscribe.ts";
import { cloneTemplate, slot } from "./template.ts";

export function renderPage(document: Document, page: Page): HTMLElement {
  switch (page.kind) {
    case "skeleton":
      return renderSkeleton(document);
    case "building":
      return renderMessage(document, "library is being built");
    case "not-found":
      return renderMessageLink(document, "podcast not found", "Back to library", "/");
    case "error":
      return renderMessageLink(document, page.message, "Open raw feed", page.feedUrl);
    case "list":
      return renderList(document, page);
    case "podcast":
      return renderPodcastPage(document, page);
  }
}

function renderList(document: Document, page: Extract<Page, { kind: "list" }>): HTMLElement {
  const main = cloneTemplate(document, "tpl-podcast-list");
  const heading = slot(main, "title");
  heading.textContent = page.title;

  if (page.opmlUrl !== undefined) {
    heading.after(renderCopyOpml(document, page.opmlUrl, navigatorFor(document)));
  }

  const list = slot(main, "podcasts");

  for (const entry of page.entries) {
    const item = cloneTemplate(document, "tpl-podcast-item");

    fillCover(slot(item, "cover"), entry.title, entry.imageUrl);

    const title = slot(item, "title");
    title.setAttribute("href", entry.href);
    title.textContent = entry.title;

    fillText(slot(item, "author"), entry.author);
    fillText(slot(item, "description"), entry.description);

    const subscribe = slot(item, "subscribe");

    if (entry.subscribeUrl !== undefined) {
      subscribe.replaceWith(renderSubscribe(document, entry.subscribeUrl, navigatorFor(document)));
    } else {
      subscribe.remove();
    }

    list.appendChild(item);
  }

  return main;
}

const SKELETON_ITEM_COUNT = 6;

function renderSkeleton(document: Document): HTMLElement {
  const main = cloneTemplate(document, "tpl-skeleton");
  const list = slot(main, "podcasts");

  for (let index = 0; index < SKELETON_ITEM_COUNT; index++) {
    list.appendChild(cloneTemplate(document, "tpl-skeleton-item"));
  }

  return main;
}

function renderPodcastPage(
  document: Document,
  page: Extract<Page, { kind: "podcast" }>,
): HTMLElement {
  const main = cloneTemplate(document, "tpl-podcast-page");

  fillCover(slot(main, "cover"), page.title, page.imageUrl);

  slot(main, "title").textContent = page.title;
  fillText(slot(main, "author"), page.author);
  fillText(slot(main, "description"), page.description);
  slot(main, "subscribe").replaceWith(
    renderSubscribe(document, page.subscribeUrl, navigatorFor(document)),
  );

  const episodes = slot(main, "episodes");

  for (const episode of page.episodes) {
    const item = cloneTemplate(document, "tpl-episode-item");

    const episodeTitle = slot(item, "title");
    episodeTitle.setAttribute("href", episode.href);
    episodeTitle.textContent = episode.title;

    fillText(
      slot(item, "duration"),
      episode.duration === undefined ? undefined : formatDuration(episode.duration),
    );

    episodes.appendChild(item);
  }

  return main;
}

function renderMessage(document: Document, message: string): HTMLElement {
  const paragraph = cloneTemplate(document, "tpl-message");
  paragraph.textContent = message;

  return paragraph;
}

function renderMessageLink(
  document: Document,
  message: string,
  label: string,
  href: string,
): HTMLElement {
  const paragraph = cloneTemplate(document, "tpl-message-link");
  paragraph.prepend(message, " ");
  const link = slot(paragraph, "link");
  link.setAttribute("href", href);
  link.textContent = label;

  return paragraph;
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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function navigatorFor(document: Document): Navigator {
  return document.defaultView?.navigator ?? globalThis.navigator;
}

// The placeholder is the cover's background, so it shows while the image
// loads, when there is none, and after a failed load removes the image.
function fillCover(cover: HTMLElement, title: string, imageUrl: string | undefined): void {
  // CSSOM, not a style attribute: the shell's CSP is style-src 'self'.
  cover.style.setProperty("--lqip", String(coverPlaceholder(title)));

  fillOrRemove(slot(cover, "cover-image"), imageUrl || undefined, (image, url) => {
    image.addEventListener("error", () => image.remove(), { once: true });
    image.setAttribute("src", url);
  });
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
