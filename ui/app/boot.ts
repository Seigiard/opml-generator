import { parseFeed, parseOpml } from "./parse-feed.ts";
import { renderPodcast, renderPodcastList } from "./render.ts";
import { feedUrlFor, normalizePath } from "./routes.ts";

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

  const route = feedUrlFor(pathname);

  if (route === null) {
    replaceWithLink(app, options.document, "podcast not found", "/");

    return;
  }

  while (true) {
    try {
      const response = await fetch(route.feedUrl);

      if (response.status === 503) {
        replaceWithMessage(app, options.document, "library is being built");
        const delay = retryDelay(response);
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), delay);
        });
        continue;
      }

      if (response.status === 404) {
        replaceWithLink(app, options.document, "podcast not found", "/");

        return;
      }

      if (!response.ok) {
        replaceWithLink(
          app,
          options.document,
          response.statusText || `HTTP ${response.status}`,
          route.feedUrl,
        );

        return;
      }

      const text = await response.text();

      if (route.kind === "list") {
        const model = parseOpml(text);
        app.replaceChildren(renderPodcastList(options.document, model, options.location.origin));
        options.document.title = model.title;
      } else {
        const feed = parseFeed(text);

        if (feed.kind === "navigation") {
          app.replaceChildren(
            renderPodcastList(options.document, feed.model, options.location.origin),
          );
          options.document.title = feed.model.title;
        } else {
          const feedUrl = new URL(route.feedUrl, options.location.origin).href;
          app.replaceChildren(renderPodcast(options.document, feed.model, feedUrl));
          options.document.title = feed.model.title;
        }
      }

      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load feed";
      replaceWithLink(app, options.document, message, route.feedUrl);

      return;
    }
  }
}

function retryDelay(response: Response): number {
  const value = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);

  return Number.isFinite(value) && value >= 0 ? value * 1000 : 5000;
}

function replaceWithMessage(app: Element, document: Document, message: string): void {
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  app.replaceChildren(paragraph);
}

function replaceWithLink(app: Element, document: Document, message: string, href: string): void {
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  const link = document.createElement("a");
  link.href = href;
  link.textContent = href === "/" ? "Back to library" : "Open raw feed";
  paragraph.appendChild(document.createTextNode(" "));
  paragraph.appendChild(link);
  app.replaceChildren(paragraph);
}
