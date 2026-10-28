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
  const small = renderCopyLink(document, feedUrl, "Copy RSS", navigator);

  small.appendChild(document.createTextNode(" · "));

  const antennaPod = document.createElement("a");
  antennaPod.href = `antennapod-subscribe://${feedUrl.replace(/^https?:\/\//, "")}`;
  antennaPod.textContent = "AntennaPod";
  small.appendChild(antennaPod);

  return small;
}

export function renderCopyOpml(
  document: Document,
  opmlUrl: string,
  navigator: SubscribeNavigator,
): HTMLElement {
  return renderCopyLink(document, opmlUrl, "Copy OPML", navigator);
}

function renderCopyLink(
  document: Document,
  url: string,
  label: string,
  navigator: SubscribeNavigator,
): HTMLElement {
  const small = document.createElement("small");
  small.className = "subscribe";

  const copy = document.createElement("a");
  copy.href = url;
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
  small.appendChild(copy);

  return small;
}

function isModifiedClick(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function showFeedback(link: HTMLAnchorElement, message: string, label: string): void {
  link.textContent = message;
  setTimeout(() => {
    link.textContent = label;
  }, FEEDBACK_MS);
}
