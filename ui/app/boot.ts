import { loadPage, type Page } from "./page.ts";
import { renderPage } from "./render.ts";
import { normalizePath } from "./routes.ts";

export interface BootOptions {
  document: Document;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  location: Pick<Location, "origin" | "pathname">;
  history: Pick<History, "replaceState">;
  setTimeout: (callback: () => void, timeout?: number) => number;
}

// Every shell page is a full document load. The browser owns history, scroll,
// and focus; speculation rules in index.html prerender the next page on hover,
// and the CSS cross-document view transition animates the swap.
export async function boot(options: BootOptions): Promise<void> {
  const { document, setTimeout } = options;
  const app = document.getElementById("app") ?? document.body;
  const defaultTitle = document.title;
  const normalizedPath = normalizePath(options.location.pathname);
  const pathname = normalizedPath ?? options.location.pathname;

  if (normalizedPath) options.history.replaceState(null, "", normalizedPath);

  while (true) {
    const page = await loadPage(pathname, options.location.origin, options.fetch);

    app.replaceChildren(renderPage(document, page));
    document.title = titleFor(page) ?? defaultTitle;

    if (page.kind !== "building") return;

    await new Promise<void>((resolve) => setTimeout(resolve, page.retryAfterMs));
  }
}

function titleFor(page: Page): string | undefined {
  return page.kind === "list" || page.kind === "podcast" ? page.title : undefined;
}
