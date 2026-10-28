import { cloneTemplate, slot } from "./template.ts";

const FEEDBACK_MS = 1500;

export interface SubscribeNavigator {
  clipboard?: {
    writeText(value: string): Promise<void>;
  };
}

export function renderSubscribe(
  document: Document,
  feedUrl: string,
  navigator: SubscribeNavigator,
): HTMLElement {
  const small = cloneTemplate(document, "tpl-subscribe");
  bindCopyLink(slot(small, "copy"), feedUrl, "Copy\u00a0RSS", navigator);
  slot(small, "antennapod").setAttribute(
    "href",
    `antennapod-subscribe://${feedUrl.replace(/^https?:\/\//, "")}`,
  );

  return small;
}

export function renderCopyOpml(
  document: Document,
  opmlUrl: string,
  navigator: SubscribeNavigator,
): HTMLElement {
  const small = cloneTemplate(document, "tpl-copy-link");
  bindCopyLink(slot(small, "copy"), opmlUrl, "Copy\u00a0OPML", navigator);

  return small;
}

function bindCopyLink(
  copy: HTMLElement,
  url: string,
  label: string,
  navigator: SubscribeNavigator,
): void {
  copy.setAttribute("href", url);
  copy.textContent = label;
  copy.addEventListener("click", (event) => {
    const clipboard = navigator.clipboard;

    if (clipboard === undefined || isModifiedClick(event)) return;

    event.preventDefault();
    clipboard.writeText(url).then(
      () => showFeedback(copy, "Copied!", label),
      () => showFeedback(copy, "Copy failed", label),
    );
  });
}

function isModifiedClick(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function showFeedback(link: HTMLElement, message: string, label: string): void {
  link.textContent = message;
  setTimeout(() => {
    link.textContent = label;
  }, FEEDBACK_MS);
}
