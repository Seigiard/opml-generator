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

  test("maps a folder page to its RSS feed", async () => {
    // #given
    const { feedUrlFor } = await import(ROUTES_MODULE);

    // #when
    const route = feedUrlFor("/books/first/");

    // #then
    expect(route).toEqual({ feedUrl: "/books/first/feed.xml", kind: "podcast" });
  });
});

describe("normalizePath", () => {
  test("returns a trailing-slash path for a folder path", async () => {
    // #given
    const { normalizePath } = await import(ROUTES_MODULE);

    // #when
    const normalized = normalizePath("/books/first");

    // #then
    expect(normalized).toBe("/books/first/");
  });

  test("does not replace a path that already has a trailing slash", async () => {
    // #given
    const { normalizePath } = await import(ROUTES_MODULE);

    // #when
    const normalized = normalizePath("/books/first/");

    // #then
    expect(normalized).toBeNull();
  });
});
