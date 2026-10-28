type RouteKind = "list" | "podcast";

export interface FeedRoute {
  feedUrl: string;
  kind: RouteKind;
}

export function feedUrlFor(pathname: string): FeedRoute | null {
  if (pathname === "/") return { feedUrl: "/feed.opml", kind: "list" };

  if (!pathname.startsWith("/browse/") || pathname.startsWith("/browse//")) return null;

  const folderPath = pathname.slice("/browse".length);
  const normalizedFolderPath = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;

  return { feedUrl: `${normalizedFolderPath}feed.xml`, kind: "podcast" };
}

export function pagePathFor(feedUrl: string, origin: string): string {
  const path = new URL(feedUrl, origin).pathname;
  const withoutFeed = path.endsWith("/feed.xml") ? path.slice(0, -"feed.xml".length) : path;
  const pagePath = withoutFeed.endsWith("/") ? withoutFeed : `${withoutFeed}/`;

  return `/browse${pagePath}`;
}

export function normalizePath(pathname: string): string | null {
  if (pathname === "/" || pathname.endsWith("/")) return null;

  if (
    pathname.startsWith("/browse//") ||
    (pathname !== "/browse" && !pathname.startsWith("/browse/"))
  ) {
    return null;
  }

  return `${pathname}/`;
}
