import { describe, expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";

import { generatePodcastRss } from "../../../src/rss/podcast-rss.ts";
import type { EpisodeInfo, PodcastInfo } from "../../../src/rss/types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_tagName, jPath) => jPath === "rss.channel.item",
});

function makePodcast(overrides: Partial<PodcastInfo> = {}): PodcastInfo {
  return {
    title: "Test Podcast",
    author: "Test Author",
    description: "A test podcast",
    imageUrl: "https://example.com/cover.jpg",
    link: "https://example.com",
    ...overrides,
  };
}

function makeEpisode(overrides: Partial<EpisodeInfo> = {}): EpisodeInfo {
  return {
    title: "Episode 1",
    guid: "books/podcast/ep01.mp3",
    pubDate: "2024-01-15T10:30:00Z",
    enclosureUrl: "https://example.com/ep01.mp3",
    enclosureLength: 12345678,
    enclosureType: "audio/mpeg",
    duration: 1234,
    episodeNumber: 1,
    ...overrides,
  };
}

describe("generatePodcastRss", () => {
  test("produces valid XML that round-trips through parser", () => {
    // #given
    const podcast = makePodcast();
    const episodes = [makeEpisode()];

    // #when
    const xml = generatePodcastRss(podcast, episodes);
    const parsed = parser.parse(xml);

    // #then
    expect(parsed.rss).toBeDefined();
    expect(parsed.rss.channel).toBeDefined();
  });

  test("includes XML declaration", () => {
    // #given / #when
    const xml = generatePodcastRss(makePodcast(), [makeEpisode()]);

    // #then
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  test("declares iTunes namespace", () => {
    // #given / #when
    const xml = generatePodcastRss(makePodcast(), [makeEpisode()]);

    // #then
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
  });

  test("sets channel title from podcast title", () => {
    // #given
    const podcast = makePodcast({ title: "My Great Show" });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel.title).toBe("My Great Show");
  });

  test("sets itunes:type to serial", () => {
    // #given / #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [makeEpisode()]));

    // #then
    expect(parsed.rss.channel["itunes:type"]).toBe("serial");
  });

  test("sets itunes:author from podcast author", () => {
    // #given
    const podcast = makePodcast({ author: "Jane Doe" });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel["itunes:author"]).toBe("Jane Doe");
  });

  test("sets itunes:image href from podcast imageUrl", () => {
    // #given
    const podcast = makePodcast({ imageUrl: "https://cdn.example.com/art.jpg" });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel["itunes:image"]["@_href"]).toBe("https://cdn.example.com/art.jpg");
  });

  test("formats guid with isPermaLink=false", () => {
    // #given
    const ep = makeEpisode({ guid: "some/path/file.mp3" });

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [ep]));
    const item = parsed.rss.channel.item[0];

    // #then
    expect(item.guid["#text"]).toBe("some/path/file.mp3");
    expect(item.guid["@_isPermaLink"]).toBe("false");
  });

  test("formats pubDate as RFC 2822", () => {
    // #given
    const ep = makeEpisode({ pubDate: "2024-01-15T10:30:00Z" });

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [ep]));
    const item = parsed.rss.channel.item[0];

    // #then
    expect(item.pubDate).toBe("Mon, 15 Jan 2024 10:30:00 GMT");
  });

  test("sets enclosure with url, length, and type attributes", () => {
    // #given
    const ep = makeEpisode({
      enclosureUrl: "https://example.com/audio.mp3",
      enclosureLength: 9876543,
      enclosureType: "audio/mpeg",
    });

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [ep]));
    const enc = parsed.rss.channel.item[0].enclosure;

    // #then
    expect(enc["@_url"]).toBe("https://example.com/audio.mp3");
    expect(enc["@_length"]).toBe("9876543");
    expect(enc["@_type"]).toBe("audio/mpeg");
  });

  test("sets itunes:duration as integer seconds", () => {
    // #given
    const ep = makeEpisode({ duration: 3661.7 });

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [ep]));
    const item = parsed.rss.channel.item[0];

    // #then
    expect(item["itunes:duration"]).toBe(3661);
  });

  test("sets itunes:episode number", () => {
    // #given
    const ep = makeEpisode({ episodeNumber: 42 });

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [ep]));
    const item = parsed.rss.channel.item[0];

    // #then
    expect(item["itunes:episode"]).toBe(42);
  });

  test("sorts episodes by episodeNumber ascending", () => {
    // #given
    const episodes = [
      makeEpisode({ episodeNumber: 3, title: "Third" }),
      makeEpisode({ episodeNumber: 1, title: "First" }),
      makeEpisode({ episodeNumber: 2, title: "Second" }),
    ];

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), episodes));
    const items = parsed.rss.channel.item;

    // #then
    expect(items[0]["itunes:episode"]).toBe(1);
    expect(items[1]["itunes:episode"]).toBe(2);
    expect(items[2]["itunes:episode"]).toBe(3);
    expect(items[0].title).toBe("First");
    expect(items[1].title).toBe("Second");
    expect(items[2].title).toBe("Third");
  });

  test("omits itunes:author when author is undefined", () => {
    // #given
    const podcast = makePodcast({ author: undefined });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel["itunes:author"]).toBeUndefined();
  });

  test("omits itunes:image when imageUrl is undefined", () => {
    // #given
    const podcast = makePodcast({ imageUrl: undefined });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel["itunes:image"]).toBeUndefined();
  });

  test("omits itunes:duration when duration is undefined", () => {
    // #given
    const ep = makeEpisode({ duration: undefined });

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), [ep]));
    const item = parsed.rss.channel.item[0];

    // #then
    expect(item["itunes:duration"]).toBeUndefined();
  });

  test("omits description when undefined", () => {
    // #given
    const podcast = makePodcast({ description: undefined });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel.description).toBeUndefined();
  });

  test("omits link when undefined", () => {
    // #given
    const podcast = makePodcast({ link: undefined });

    // #when
    const parsed = parser.parse(generatePodcastRss(podcast, [makeEpisode()]));

    // #then
    expect(parsed.rss.channel.link).toBeUndefined();
  });

  test("handles multiple episodes", () => {
    // #given
    const episodes = [
      makeEpisode({ episodeNumber: 1, title: "Ep 1" }),
      makeEpisode({ episodeNumber: 2, title: "Ep 2" }),
      makeEpisode({ episodeNumber: 3, title: "Ep 3" }),
    ];

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), episodes));

    // #then
    expect(parsed.rss.channel.item).toHaveLength(3);
  });

  test("handles different enclosure types", () => {
    // #given
    const episodes = [
      makeEpisode({ episodeNumber: 1, enclosureType: "audio/mpeg" }),
      makeEpisode({ episodeNumber: 2, enclosureType: "audio/mp4" }),
      makeEpisode({ episodeNumber: 3, enclosureType: "audio/ogg" }),
    ];

    // #when
    const parsed = parser.parse(generatePodcastRss(makePodcast(), episodes));

    // #then
    expect(parsed.rss.channel.item[0].enclosure["@_type"]).toBe("audio/mpeg");
    expect(parsed.rss.channel.item[1].enclosure["@_type"]).toBe("audio/mp4");
    expect(parsed.rss.channel.item[2].enclosure["@_type"]).toBe("audio/ogg");
  });
});
