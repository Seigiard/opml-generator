import { loadPage } from "./page.ts";
import { renderPage } from "./render.ts";
import { normalizePath } from "./routes.ts";

export interface BootOptions {
  document: Document;
  fetch: (input: string | URL | Request) => Promise<Response>;
  location: Pick<Location, "origin" | "pathname">;
  history: Pick<History, "replaceState">;
  setTimeout: (callback: () => void, timeout?: number) => number;
}

export async function boot(options: BootOptions): Promise<void> {
  const { fetch, setTimeout } = options;
  const app = options.document.getElementById("app") ?? options.document.body;
  const normalizedPath = normalizePath(options.location.pathname);
  const pathname = normalizedPath ?? options.location.pathname;

  if (normalizedPath) options.history.replaceState(null, "", normalizedPath);

  while (true) {
    const page = await loadPage(pathname, options.location.origin, fetch);

    if (page.kind === "building") {
      app.replaceChildren(renderPage(options.document, page));
      await new Promise<void>((resolve) => {
        setTimeout(() => resolve(), page.retryAfterMs);
      });
      continue;
    }

    app.replaceChildren(renderPage(options.document, page));

    if (page.kind === "list" || page.kind === "podcast") {
      options.document.title = page.title;
    }

    return;
  }
}
