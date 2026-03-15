import { XMLBuilder } from "fast-xml-parser";

import type { EpisodeInfo, PodcastInfo } from "./types.ts";
import { BASE_URL_PLACEHOLDER } from "../constants.ts";

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

export function generatePodcastRss(podcast: PodcastInfo, episodes: EpisodeInfo[]): string {
  const sorted = [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);

  const channel: Record<string, unknown> = {
    title: podcast.title,
  };

  if (podcast.link) {
    channel.link = podcast.link;
  }

  if (podcast.description) {
    channel.description = podcast.description;
  }

  if (podcast.author) {
    channel["itunes:author"] = podcast.author;
  }

  if (podcast.imageUrl) {
    channel["itunes:image"] = { "@_href": `${BASE_URL_PLACEHOLDER}${podcast.imageUrl}` };
  }

  channel["itunes:type"] = "serial";

  channel.item = sorted.map((ep) => {
    const item: Record<string, unknown> = {
      title: ep.title,
      guid: { "#text": ep.guid, "@_isPermaLink": "false" },
      pubDate: new Date(ep.pubDate).toUTCString(),
      enclosure: {
        "@_url": `${BASE_URL_PLACEHOLDER}${ep.enclosureUrl}`,
        "@_length": String(ep.enclosureLength),
        "@_type": ep.enclosureType,
      },
    };

    if (ep.duration != null) {
      item["itunes:duration"] = Math.floor(ep.duration);
    }

    item["itunes:episode"] = ep.episodeNumber;

    return item;
  });

  const rssObj = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    "?xml-stylesheet": { "@_type": "text/xsl", "@_href": "/static/layout.xsl" },
    rss: {
      "@_version": "2.0",
      "@_xmlns:itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
      channel,
    },
  };

  return builder.build(rssObj) as string;
}
