import { describe, expect, test } from "bun:test";
import { XMLParser } from "fast-xml-parser";

import { generateOpml } from "../../../src/rss/opml.ts";
import type { OpmlOutline } from "../../../src/rss/types.ts";
import { BASE_URL_PLACEHOLDER } from "../../../src/constants.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (_tagName, jPath) => jPath === "opml.body.outline",
});

function makeOutline(overrides: Partial<OpmlOutline> = {}): OpmlOutline {
  return {
    title: "Test Feed",
    feedUrl: "https://example.com/feed.xml",
    htmlUrl: "https://example.com",
    ...overrides,
  };
}

describe("generateOpml", () => {
  test("produces valid XML that round-trips through parser", () => {
    // #given
    const feeds = [makeOutline()];

    // #when
    const xml = generateOpml("My Feeds", feeds);
    const parsed = parser.parse(xml);

    // #then
    expect(parsed.opml).toBeDefined();
    expect(parsed.opml.head).toBeDefined();
    expect(parsed.opml.body).toBeDefined();
  });

  test("includes XML declaration", () => {
    // #given / #when
    const xml = generateOpml("My Feeds", [makeOutline()]);

    // #then
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  test("sets OPML version to 2.0", () => {
    // #given / #when
    const parsed = parser.parse(generateOpml("My Feeds", [makeOutline()]));

    // #then
    expect(parsed.opml["@_version"]).toBe("2.0");
  });

  test("sets head title", () => {
    // #given / #when
    const parsed = parser.parse(generateOpml("Audiobook Collection", [makeOutline()]));

    // #then
    expect(parsed.opml.head.title).toBe("Audiobook Collection");
  });

  test("sets outline text and title attributes", () => {
    // #given
    const feed = makeOutline({ title: "Great Podcast" });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_text"]).toBe("Great Podcast");
    expect(outline["@_title"]).toBe("Great Podcast");
  });

  test("sets outline type to rss", () => {
    // #given / #when
    const parsed = parser.parse(generateOpml("Feeds", [makeOutline()]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_type"]).toBe("rss");
  });

  test("prepends BASE_URL placeholder to xmlUrl", () => {
    // #given
    const feed = makeOutline({ feedUrl: "/Author/Book/feed.xml" });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_xmlUrl"]).toBe(`${BASE_URL_PLACEHOLDER}/Author/Book/feed.xml`);
  });

  test("sets outline htmlUrl when provided", () => {
    // #given
    const feed = makeOutline({ htmlUrl: "https://example.com/page" });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_htmlUrl"]).toBe("https://example.com/page");
  });

  test("omits htmlUrl when undefined", () => {
    // #given
    const feed = makeOutline({ htmlUrl: undefined });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_htmlUrl"]).toBeUndefined();
  });

  test("produces multiple outlines for multiple feeds", () => {
    // #given
    const feeds = [
      makeOutline({ title: "Feed A", feedUrl: "https://a.example.com/rss.xml" }),
      makeOutline({ title: "Feed B", feedUrl: "https://b.example.com/rss.xml" }),
      makeOutline({ title: "Feed C", feedUrl: "https://c.example.com/rss.xml" }),
    ];

    // #when
    const parsed = parser.parse(generateOpml("All Feeds", feeds));

    // #then
    expect(parsed.opml.body.outline).toHaveLength(3);
    expect(parsed.opml.body.outline[0]["@_title"]).toBe("Feed A");
    expect(parsed.opml.body.outline[1]["@_title"]).toBe("Feed B");
    expect(parsed.opml.body.outline[2]["@_title"]).toBe("Feed C");
  });

  test("sets outline description when provided", () => {
    // #given
    const feed = makeOutline({ description: "A great audiobook" });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_description"]).toBe("A great audiobook");
  });

  test("sets outline author when provided", () => {
    // #given
    const feed = makeOutline({ author: "Jane Doe" });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_author"]).toBe("Jane Doe");
  });

  test("sets outline imageUrl when provided", () => {
    // #given
    const feed = makeOutline({ imageUrl: "{{{BASE_URL}}}/data/Author/Book/cover.jpg" });

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_imageUrl"]).toBe("{{{BASE_URL}}}/data/Author/Book/cover.jpg");
  });

  test("omits description, author, imageUrl when undefined", () => {
    // #given
    const feed = makeOutline();

    // #when
    const parsed = parser.parse(generateOpml("Feeds", [feed]));
    const outline = parsed.opml.body.outline[0];

    // #then
    expect(outline["@_description"]).toBeUndefined();
    expect(outline["@_author"]).toBeUndefined();
    expect(outline["@_imageUrl"]).toBeUndefined();
  });

  test("produces valid OPML with empty feeds list", () => {
    // #given / #when
    const xml = generateOpml("Empty", []);
    const parsed = parser.parse(xml);

    // #then
    expect(parsed.opml["@_version"]).toBe("2.0");
    expect(parsed.opml.head.title).toBe("Empty");
    expect(parsed.opml.body).toBeDefined();
  });
});
