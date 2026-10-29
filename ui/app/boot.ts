import { type ShellNavigateEvent, type ShellNavigation, shellPathFor } from "./navigation.ts";
import { loadPage, type Page } from "./page.ts";
import { renderPage } from "./render.ts";
import { normalizePath } from "./routes.ts";

export interface BootOptions {
  document: Document;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  location: Pick<Location, "origin" | "pathname">;
  history: Pick<History, "replaceState">;
  setTimeout: (callback: () => void, timeout?: number) => number;
  navigation?: ShellNavigation;
}

interface Shell {
  options: BootOptions;
  app: HTMLElement;
  defaultTitle: string;
}

export async function boot(options: BootOptions): Promise<void> {
  const app = options.document.getElementById("app") ?? options.document.body;
  const shell: Shell = { options, app, defaultTitle: options.document.title };
  const normalizedPath = normalizePath(options.location.pathname);
  const pathname = normalizedPath ?? options.location.pathname;

  if (normalizedPath) options.history.replaceState(null, "", normalizedPath);

  const initialLoad = new AbortController();

  options.navigation?.addEventListener("navigate", (event) => {
    const destination = shellPathFor(event, options.location.origin);

    if (destination === null) return;

    initialLoad.abort();
    event.intercept({
      focusReset: "manual",
      scroll: "manual",
      handler: () =>
        showPage(
          shell,
          destination,
          event.signal,
          (update) => transition(options.document, update),
          () => {
            restoreScroll(options.document, event);
            focusHeading(app);
          },
        ),
    });
  });

  await showPage(
    shell,
    pathname,
    initialLoad.signal,
    (update) => {
      update();

      return Promise.resolve();
    },
    () => {},
  );
}

// Keeps the current page on screen until the next one is loaded, so the swap
// (and its view transition) goes from one finished page to the next. `settle`
// runs inside the swap: in Chromium, Back/Forward scroll restored after a view
// transition's update lands on a stale position.
async function showPage(
  shell: Shell,
  pathname: string,
  signal: AbortSignal,
  swap: (update: () => void) => Promise<void>,
  settle: () => void,
): Promise<void> {
  const { document } = shell.options;

  while (true) {
    const page = await loadPage(
      pathname,
      shell.options.location.origin,
      shell.options.fetch,
      signal,
    );

    if (signal.aborted) return;

    await swap(() => {
      if (signal.aborted) return;

      shell.app.replaceChildren(renderPage(document, page));
      document.title = titleFor(page) ?? shell.defaultTitle;

      if (page.kind !== "building") settle();
    });

    if (page.kind !== "building") return;

    await wait(shell.options.setTimeout, page.retryAfterMs, signal);

    if (signal.aborted) return;
  }
}

function transition(document: Document, update: () => void): Promise<void> {
  if (!("startViewTransition" in document)) {
    update();

    return Promise.resolve();
  }

  return document.startViewTransition(update).updateCallbackDone;
}

function titleFor(page: Page): string | undefined {
  return page.kind === "list" || page.kind === "podcast" ? page.title : undefined;
}

// The browser restores Back/Forward positions and scrolls to a fragment, but
// without a fragment it leaves a push or replace where the old page was.
function restoreScroll(document: Document, event: ShellNavigateEvent): void {
  if (event.navigationType === "traverse" || new URL(event.destination.url).hash !== "") {
    event.scroll();
  } else {
    document.scrollingElement?.scrollTo(0, 0);
  }
}

function focusHeading(app: HTMLElement): void {
  const heading = app.querySelector("h1");

  if (heading === null) return;

  heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

function wait(
  setTimeout: BootOptions["setTimeout"],
  timeout: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), timeout);
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
