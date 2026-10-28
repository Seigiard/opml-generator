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
