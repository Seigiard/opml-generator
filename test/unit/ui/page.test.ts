import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const PAGE_MODULE = "../../../ui/app/page.ts";

const originalDomParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");

beforeAll(() => {
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    writable: true,
    value: new Window().DOMParser,
  });
});

afterAll(() => {
  if (originalDomParser) {
    Object.defineProperty(globalThis, "DOMParser", originalDomParser);
  } else {
    Reflect.deleteProperty(globalThis, "DOMParser");
  }
});

describe("loadPage", () => {
  test("returns resolved page data for the root OPML list", async () => {
    // #given
    const text = await Bun.file(
      new URL("../../fixtures/feeds/library.opml", import.meta.url),
    ).text();

    const fetched: string[] = [];
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage("/", "https://library.example", async (input: string) => {
      fetched.push(input);

      return new Response(text, { status: 200 });
    });

    // #then
    expect({ page, fetched }).toEqual({
      page: {
        kind: "list",
        title: "Audio Library",
        opmlUrl: "https://library.example/feed.opml",
        entries: [
          {
            title: "First & Finest",
            href: "/browse/books/first/",
            author: "Ada Author",
            description: "A <b>literal</b> description",
            imageUrl: "https://library.example/covers/first.jpg",
            subscribeUrl: "https://library.example/books/first/feed.xml",
          },
          {
            title: "Minimal Podcast",
            href: "/browse/books/minimal/",
            subscribeUrl: "https://library.example/books/minimal/feed.xml",
          },
        ],
      },
      fetched: ["/feed.opml"],
    });
  });

  test("returns resolved page data for a navigation feed", async () => {
    // #given
    const text = await Bun.file(
      new URL("../../fixtures/feeds/navigation.xml", import.meta.url),
    ).text();

    const fetched: string[] = [];
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/Parent/",
      "https://library.example",
      async (input: string) => {
        fetched.push(input);

        return new Response(text, { status: 200 });
      },
    );

    // #then
    expect({ page, fetched }).toEqual({
      page: {
        kind: "list",
        title: "Parent & Group",
        entries: [
          {
            title: "Podcast One",
            href: "/browse/Parent/Podcast%20One/",
            description: "3 items",
            subscribeUrl: "https://library.example/Parent/Podcast%20One/feed.xml",
          },
          {
            title: "Nested Group",
            href: "/browse/Parent/Nested%20Group/",
            description: "2 items",
          },
          {
            title: "Legacy Child",
            href: "/browse/Parent/Legacy%20Child/",
            description: "1 item",
          },
        ],
      },
      fetched: ["/Parent/feed.xml"],
    });
  });

  test("returns resolved page data for a podcast RSS feed", async () => {
    // #given
    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    const fetched: string[] = [];
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/books/first/",
      "https://library.example",
      async (input: string) => {
        fetched.push(input);

        return new Response(text, { status: 200 });
      },
    );

    // #then
    expect({ page, fetched }).toEqual({
      page: {
        kind: "podcast",
        title: "First & Finest",
        author: "Ada Author",
        description: "A narrated collection",
        imageUrl: "https://library.example/covers/first.jpg",
        subscribeUrl: "https://library.example/books/first/feed.xml",
        episodes: [
          {
            title: "Opening <b>Chapter</b>",
            href: "https://library.example/audio/opening.mp3",
            duration: 59,
          },
          {
            title: "Long Chapter",
            href: "https://library.example/audio/long.mp3",
          },
        ],
      },
      fetched: ["/books/first/feed.xml"],
    });
  });

  test("returns the Retry-After delay for a building feed", async () => {
    // #given
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/books/first/",
      "https://library.example",
      async () => new Response(null, { status: 503, headers: { "Retry-After": "7" } }),
    );

    // #then
    expect(page).toEqual({ kind: "building", retryAfterMs: 7000 });
  });

  test.each([
    ["missing", undefined],
    ["invalid", "later"],
  ])("uses the default building delay when Retry-After is %s", async (_label, value) => {
    // #given
    const headers = value === undefined ? undefined : { "Retry-After": value };
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/books/first/",
      "https://library.example",
      async () => new Response(null, { status: 503, headers }),
    );

    // #then
    expect(page).toEqual({ kind: "building", retryAfterMs: 5000 });
  });

  test("returns not found after fetching a missing feed", async () => {
    // #given
    const fetched: string[] = [];
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/books/missing/",
      "https://library.example",
      async (input: string) => {
        fetched.push(input);

        return new Response(null, { status: 404 });
      },
    );

    // #then
    expect({ page, fetched }).toEqual({
      page: { kind: "not-found" },
      fetched: ["/books/missing/feed.xml"],
    });
  });

  test("returns an HTTP status message and the raw feed URL for another failure", async () => {
    // #given
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/books/broken/",
      "https://library.example",
      async () => new Response(null, { status: 500, statusText: "Upstream failed" }),
    );

    // #then
    expect(page).toEqual({
      kind: "error",
      message: "Upstream failed",
      feedUrl: "/books/broken/feed.xml",
    });
  });

  test("falls back to the HTTP status code when status text is empty", async () => {
    // #given
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/browse/books/broken/",
      "https://library.example",
      async () => new Response(null, { status: 502 }),
    );

    // #then
    expect(page).toEqual({
      kind: "error",
      message: "HTTP 502",
      feedUrl: "/books/broken/feed.xml",
    });
  });

  test("returns an error page with the thrown fetch message", async () => {
    // #given
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage("/browse/books/broken/", "https://library.example", () =>
      Promise.reject(new Error("network unavailable")),
    );

    // #then
    expect(page).toEqual({
      kind: "error",
      message: "network unavailable",
      feedUrl: "/books/broken/feed.xml",
    });
  });

  test("uses the fallback message for a non-Error fetch rejection", async () => {
    // #given
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage("/browse/books/broken/", "https://library.example", () =>
      Promise.reject("offline"),
    );

    // #then
    expect(page).toEqual({
      kind: "error",
      message: "Could not load feed",
      feedUrl: "/books/broken/feed.xml",
    });
  });

  test("returns not found without fetching outside the browser URL contract", async () => {
    // #given
    const fetched: string[] = [];
    const { loadPage } = await import(PAGE_MODULE);

    // #when
    const page = await loadPage(
      "/books/first/",
      "https://library.example",
      async (input: string) => {
        fetched.push(input);

        return new Response(null, { status: 200 });
      },
    );

    // #then
    expect({ page, fetched }).toEqual({ page: { kind: "not-found" }, fetched: [] });
  });
});
