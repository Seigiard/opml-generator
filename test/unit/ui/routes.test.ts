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
