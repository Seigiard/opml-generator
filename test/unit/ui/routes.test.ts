import { describe, expect, test } from "bun:test";

const ROUTES_MODULE = "../../../ui/app/routes.ts";

describe("feedUrlFor", () => {
  test("maps the root page to the OPML feed", async () => {
    // #given
    const { feedUrlFor } = await import(ROUTES_MODULE);

    // #when
    const route = feedUrlFor("/");

    // #then
    expect(route).toEqual({ feedUrl: "/feed.opml", kind: "list" });
  });

  test.each([
    ["/browse/books/first/", { feedUrl: "/books/first/feed.xml", kind: "podcast" }],
    ["/browse/", { feedUrl: "/feed.xml", kind: "podcast" }],
    ["/browse//evil.example/x/", null],
    ["/books/first/", null],
  ])("maps %s according to the browser URL contract", async (pathname, expected) => {
    // #given
    const { feedUrlFor } = await import(ROUTES_MODULE);

    // #when
    const route = feedUrlFor(pathname);

    // #then
    expect(route).toEqual(expected);
  });
});

describe("pagePathFor", () => {
  test.each([
    ["https://library.example/books/first/feed.xml", "/browse/books/first/"],
    ["https://library.example/feed.xml", "/browse/"],
    ["/Parent/Podcast%20One/feed.xml", "/browse/Parent/Podcast%20One/"],
  ])("maps %s to %s", async (feedUrl, expected) => {
    // #given
    const { pagePathFor } = await import(ROUTES_MODULE);

    // #when
    const pagePath = pagePathFor(feedUrl, "https://library.example");

    // #then
    expect(pagePath).toBe(expected);
  });

  test.each([
    [
      "https://library.example/books/first/feed.xml",
      "/browse/books/first/",
      "/books/first/feed.xml",
    ],
    ["https://library.example/feed.xml", "/browse/", "/feed.xml"],
    [
      "/Parent/Podcast%20One/feed.xml",
      "/browse/Parent/Podcast%20One/",
      "/Parent/Podcast%20One/feed.xml",
    ],
  ])(
    "round-trips %s through its browser page",
    async (feedUrl, expectedPagePath, expectedFeedUrl) => {
      // #given
      const { feedUrlFor, pagePathFor } = await import(ROUTES_MODULE);

      // #when
      const pagePath = pagePathFor(feedUrl, "https://library.example");
      const route = feedUrlFor(pagePath);

      // #then
      expect({ pagePath, route }).toEqual({
        pagePath: expectedPagePath,
        route: { feedUrl: expectedFeedUrl, kind: "podcast" },
      });
    },
  );
});

describe("normalizePath", () => {
  test.each([
    ["/browse/books/first", "/browse/books/first/"],
    ["/browse", "/browse/"],
    ["/browse/books/first/", null],
    ["/browse//evil.example/x", null],
    ["/books/first", null],
  ])("normalizes %s according to the browser URL contract", async (pathname, expected) => {
    // #given
    const { normalizePath } = await import(ROUTES_MODULE);

    // #when
    const normalized = normalizePath(pathname);

    // #then
    expect(normalized).toEqual(expected);
  });
});
