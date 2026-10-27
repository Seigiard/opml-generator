type RouteKind = "list" | "podcast";

export interface FeedRoute {
  feedUrl: string;
  kind: RouteKind;
}

export function feedUrlFor(pathname: string): FeedRoute {
  if (pathname === "/") return { feedUrl: "/feed.opml", kind: "list" };

  const folderPath = pathname.endsWith("/") ? pathname : `${pathname}/`;

  return { feedUrl: `${folderPath}feed.xml`, kind: "podcast" };
}

export function normalizePath(pathname: string): string | null {
  if (pathname === "/" || pathname.endsWith("/")) return null;

  return `${pathname}/`;
}
