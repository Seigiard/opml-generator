import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const BOOT_MODULE = "../../../ui/app/boot.ts";

const originalDomParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");

type BrowserFunctionReceiver = typeof globalThis | undefined;

function requireGlobalReceiver<Arguments extends unknown[], Result>(
  implementation: (...args: Arguments) => Result,
): (...args: Arguments) => Result {
  return function (this: BrowserFunctionReceiver, ...args: Arguments): Result {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }

    return implementation(...args);
  };
}

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

describe("boot", () => {
  test("renders a navigation feed as an ordered child list with podcast-only subscriptions", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse/Parent/" });

    const text = await Bun.file(
      new URL("../../fixtures/feeds/navigation.xml", import.meta.url),
    ).text();

    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(text, { status: 200 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const items = Array.from(window.document.querySelectorAll("ul.podcasts > li.podcast"));

    // #then
    expect({
      documentTitle: window.document.title,
      heading: window.document.querySelector("h1")?.textContent,
      items: items.map((item) => ({
        title: item.querySelector("a.podcast__title")?.textContent,
        href: item.querySelector("a.podcast__title")?.getAttribute("href"),
        subscribe: item.querySelector("small.subscribe a:last-child")?.getAttribute("href") ?? null,
      })),
      podcastHeaderCount: window.document.querySelectorAll("header.feed-header").length,
      episodeListCount: window.document.querySelectorAll("ol.episodes").length,
      libraryLinkCount: window.document.querySelectorAll("main > small.subscribe").length,
    }).toEqual({
      documentTitle: "Parent & Group",
      heading: "Parent & Group",
      items: [
        {
          title: "Podcast One",
          href: "/browse/Parent/Podcast%20One/",
          subscribe: "antennapod-subscribe://library.example/Parent/Podcast%20One/feed.xml",
        },
        {
          title: "Nested Group",
          href: "/browse/Parent/Nested%20Group/",
          subscribe: null,
        },
        {
          title: "Legacy Child",
          href: "/browse/Parent/Legacy%20Child/",
          subscribe: null,
        },
      ],
      podcastHeaderCount: 0,
      episodeListCount: 0,
      libraryLinkCount: 0,
    });
  });

  test("renders the library OPML link under the library heading", async () => {
    // #given
    const window = new Window({ url: "https://library.example/" });

    const text = await Bun.file(
      new URL("../../fixtures/feeds/library.opml", import.meta.url),
    ).text();

    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(text, { status: 200 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    const heading = window.document.querySelector("main > h1");

    const libraryLinks = Array.from(
      window.document.querySelectorAll("main > small.subscribe a"),
      (link) => ({ text: link.textContent, href: link.getAttribute("href") }),
    );

    // #then
    expect({
      heading: heading?.textContent,
      followsHeading: heading?.nextElementSibling?.className,
      libraryLinks,
    }).toEqual({
      heading: "Audio Library",
      followsHeading: "subscribe",
      libraryLinks: [{ text: "Copy\u00a0OPML", href: "https://library.example/feed.opml" }],
    });
  });

  test("keeps rendering podcast RSS as a podcast page", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse/books/first/" });

    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(text, { status: 200 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      documentTitle: window.document.title,
      title: window.document.querySelector("h1.feed-header__title")?.textContent,
      episodes: Array.from(
        window.document.querySelectorAll("ol.episodes > li.episode a.episode__title"),
        (episode) => episode.textContent,
      ),
      navigationListCount: window.document.querySelectorAll("ul.podcasts").length,
    }).toEqual({
      documentTitle: "First & Finest",
      title: "First & Finest",
      episodes: ["Opening <b>Chapter</b>", "Long Chapter"],
      navigationListCount: 0,
    });
  });

  test("normalizes a browser path before fetching its RSS feed", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse/books/first" });

    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    const events: string[] = [];
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: {
        replaceState: (_data: null, _unused: string, url?: string | URL | null) => {
          events.push(`replaceState:${String(url)}`);
        },
      },
      fetch: requireGlobalReceiver(async (input: string | URL | Request) => {
        events.push(`fetch:${String(input)}`);

        return new Response(text, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect(events).toEqual(["replaceState:/browse/books/first/", "fetch:/books/first/feed.xml"]);
  });

  test("shows the building message and retries after Retry-After seconds", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse/books/first/" });

    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    let calls = 0;
    let delay: number | undefined;
    let messageAtSchedule = "";
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => {
        calls += 1;

        if (calls === 1) {
          return new Response(null, { status: 503, headers: { "Retry-After": "7" } });
        }

        return new Response(text, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver((callback: () => void, timeout?: number) => {
        delay = timeout;
        messageAtSchedule = window.document.body.textContent?.trim() ?? "";
        callback();

        return 1;
      }),
    });

    // #then
    expect({ calls, delay, messageAtSchedule }).toEqual({
      calls: 2,
      delay: 7000,
      messageAtSchedule: "library is being built",
    });
  });

  test("renders a not-found message with a link to the library", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse/books/missing/" });
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async () => new Response(null, { status: 404 })),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      hasMessage: window.document.body.textContent?.includes("podcast not found"),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
    }).toEqual({ hasMessage: true, href: "/" });
  });

  test("renders an HTTP failure with a link to the raw feed", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse/books/broken/" });
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(
        async () => new Response(null, { status: 500, statusText: "Internal Server Error" }),
      ),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      hasMessage: window.document.body.textContent?.includes("Internal Server Error"),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
    }).toEqual({ hasMessage: true, href: "/books/broken/feed.xml" });
  });

  test("renders not found without fetching outside the browser URL contract", async () => {
    // #given
    const window = new Window({ url: "https://library.example/books/first/" });
    const events: string[] = [];
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async (input: string | URL | Request) => {
        events.push(`fetch:${String(input)}`);

        return new Response(null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      message: window.document.body.textContent?.trim(),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
      events,
    }).toEqual({ message: "podcast not found Back to library", href: "/", events: [] });
  });

  test("renders not found without fetching a protocol-relative browse path", async () => {
    // #given
    const window = new Window({ url: "https://library.example/browse//evil.example/x/" });
    const events: string[] = [];
    const { boot } = await import(BOOT_MODULE);

    // #when
    await boot({
      document: window.document,
      location: window.location,
      history: window.history,
      fetch: requireGlobalReceiver(async (input: string | URL | Request) => {
        events.push(`fetch:${String(input)}`);

        return new Response(null, { status: 200 });
      }),
      setTimeout: requireGlobalReceiver(() => 1),
    });

    // #then
    expect({
      message: window.document.body.textContent?.trim(),
      href: window.document.body.querySelector("a")?.getAttribute("href"),
      events,
    }).toEqual({ message: "podcast not found Back to library", href: "/", events: [] });
  });
});
