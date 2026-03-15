import { XMLBuilder } from "fast-xml-parser";

import type { OpmlOutline } from "./types.ts";
import { BASE_URL_PLACEHOLDER } from "../constants.ts";

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

export function generateOpml(title: string, feeds: OpmlOutline[]): string {
  const outlines = feeds.map((feed) => {
    const outline: Record<string, string> = {
      "@_text": feed.title,
      "@_title": feed.title,
      "@_type": "rss",
      "@_xmlUrl": `${BASE_URL_PLACEHOLDER}${feed.feedUrl}`,
    };

    if (feed.htmlUrl) {
      outline["@_htmlUrl"] = feed.htmlUrl;
    }

    return outline;
  });

  const opmlObj = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    "?xml-stylesheet": { "@_type": "text/xsl", "@_href": "/static/layout.xsl" },
    opml: {
      "@_version": "2.0",
      head: { title },
      body: {
        outline: outlines,
      },
    },
  };

  return builder.build(opmlObj) as string;
}
