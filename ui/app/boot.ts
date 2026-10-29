import { feedsToPrefetch, loadPage, type Page } from "./page.ts";
import { renderPage } from "./render.ts";
import { normalizePath } from "./routes.ts";

const LOADING_DELAY_MS = 300;

export interface BootOptions {
  document: Document;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  location: Pick<Location, "origin" | "pathname">;
  history: Pick<History, "replaceState">;
  setTimeout: (callback: () => void, timeout?: number) => number;
  saveData?: boolean;
}

// Every shell page is a full document load. The browser owns history, scroll,
// and focus; speculation rules in index.html prerender the next page on hover,
// and the CSS cross-document view transition animates the swap.
export async function boot(options: BootOptions): Promise<void> {
  const { document, fetch, setTimeout } = options;
  const app = document.getElementById("app") ?? document.body;
  const defaultTitle = document.title;
  const normalizedPath = normalizePath(options.location.pathname);
  const pathname = normalizedPath ?? options.location.pathname;

  if (normalizedPath) options.history.replaceState(null, "", normalizedPath);

  const show = (page: Page): void => {
    app.replaceChildren(renderPage(document, page));
    document.title = titleFor(page) ?? defaultTitle;
  };

  const load = (): Promise<Page> => loadPage(pathname, options.location.origin, fetch);

  // A fast feed renders straight away; a slow one shows the skeleton first.
  const firstLoad = load();

  let page = await Promise.race([
    firstLoad,
    wait(setTimeout, LOADING_DELAY_MS).then(() => undefined),
  ]);

  if (page === undefined) {
    show({ kind: "skeleton" });
    page = await firstLoad;
  }

  while (true) {
    show(page);

    if (page.kind !== "building") break;

    await wait(setTimeout, page.retryAfterMs);
    page = await load();
  }

  for (const feedUrl of feedsToPrefetch(page, options.saveData === true)) {
    // SAFETY: browsers accept `priority`; the RequestInit type omits it.
    void fetch(feedUrl, { priority: "low" } as RequestInit).catch(() => undefined);
  }
}

function titleFor(page: Page): string | undefined {
  return page.kind === "list" || page.kind === "podcast" ? page.title : undefined;
}

function wait(setTimeout: BootOptions["setTimeout"], timeout: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, timeout));
}
