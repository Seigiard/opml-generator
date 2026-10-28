import { describe, expect, test } from "bun:test";
import type { HTMLElement, Node } from "happy-dom";
import { createUiWindow } from "../../helpers/ui-document.ts";

const RENDER_MODULE = "../../../ui/app/render.ts";

describe("renderPage", () => {
  test("renders a list with resolved page, subscription, and OPML links", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const root = renderPage(document, {
      kind: "list",
      title: "Audio Library",
      opmlUrl: "https://library.example/feed.opml",
      entries: [
        {
          title: "First & Finest",
          href: "/browse/books/first/",
          author: "Ada Author",
          description: "A narrated collection",
          imageUrl: "https://library.example/covers/first.jpg",
          subscribeUrl: "https://library.example/books/first/feed.xml",
        },
        {
          title: "Root Podcast",
          href: "/browse/",
          subscribeUrl: "https://library.example/feed.xml",
        },
      ],
    });

    const items = root.querySelectorAll("li.podcast");
    const first = items[0];
    const second = items[1];
    const opmlLinks = root.querySelectorAll("main > small.subscribe a");
    const subscribeLinks = first?.querySelectorAll("small.subscribe a") ?? [];

    // #then
    expect({
      root: root.tagName,
      heading: root.querySelector("h1")?.textContent,
      opml: [
        {
          text: opmlLinks[0]?.textContent,
          href: opmlLinks[0]?.getAttribute("href"),
        },
      ],
      list: root.querySelector("ul")?.className,
      itemCount: items.length,
      cover: {
        src: first?.querySelector(".podcast__cover img")?.getAttribute("src"),
        alt: first?.querySelector(".podcast__cover img")?.getAttribute("alt"),
      },
      body: first?.querySelector("div.podcast__body")?.tagName,
      titleLinks: [first, second].map((item) => ({
        text: item?.querySelector("a.podcast__title")?.textContent,
        href: item?.querySelector("a.podcast__title")?.getAttribute("href"),
      })),
      author: first?.querySelector("small.podcast__author")?.textContent,
      description: first?.querySelector("p.podcast__desc")?.textContent,
      subscribe: [
        {
          text: subscribeLinks[0]?.textContent,
          href: subscribeLinks[0]?.getAttribute("href"),
        },
        {
          text: subscribeLinks[1]?.textContent,
          href: subscribeLinks[1]?.getAttribute("href"),
        },
      ],
      minimalOptionalElementCount: second?.querySelectorAll(
        ".podcast__cover img, .podcast__author, .podcast__desc",
      ).length,
    }).toEqual({
      root: "MAIN",
      heading: "Audio Library",
      opml: [{ text: "Copy OPML", href: "https://library.example/feed.opml" }],
      list: "podcasts",
      itemCount: 2,
      cover: {
        src: "https://library.example/covers/first.jpg",
        alt: "",
      },
      body: "DIV",
      titleLinks: [
        { text: "First & Finest", href: "/browse/books/first/" },
        { text: "Root Podcast", href: "/browse/" },
      ],
      author: "Ada Author",
      description: "A narrated collection",
      subscribe: [
        { text: "Copy RSS", href: "https://library.example/books/first/feed.xml" },
        {
          text: "AntennaPod",
          href: "antennapod-subscribe://library.example/books/first/feed.xml",
        },
      ],
      minimalOptionalElementCount: 0,
    });
  });

  test("renders feed text as text instead of markup", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const root = renderPage(document, {
      kind: "list",
      title: "Library",
      entries: [{ title: "<b>x</b>", href: "/browse/books/unsafe/" }],
    });

    const title = root.querySelector("a.podcast__title");

    // #then
    expect({ text: title?.textContent, childCount: title?.children.length }).toEqual({
      text: "<b>x</b>",
      childCount: 0,
    });
  });

  test("renders a podcast header, navigation, subscription, and episode list", async () => {
    // #given
    const document = createUiWindow("https://library.example/books/first/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const root = renderPage(document, {
      kind: "podcast",
      title: "First & Finest",
      author: "Ada Author",
      description: "A narrated collection",
      imageUrl: "https://library.example/covers/first.jpg",
      subscribeUrl: "https://library.example/books/first/feed.xml",
      episodes: [
        {
          title: "Opening Chapter",
          href: "https://library.example/audio/opening.mp3",
          duration: 59,
        },
        {
          title: "Long Chapter",
          href: "https://library.example/audio/long.mp3",
          duration: 3661,
        },
      ],
    });

    const episodes = root.querySelectorAll("ol.episodes > li.episode");
    const firstEpisode = episodes[0];
    const secondEpisode = episodes[1];

    // #then
    expect({
      back: {
        text: root.querySelector("nav a")?.textContent,
        href: root.querySelector("nav a")?.getAttribute("href"),
      },
      header: root.querySelector("header")?.className,
      cover: root.querySelector(".feed-header__cover img")?.getAttribute("src"),
      info: root.querySelector("hgroup")?.className,
      title: root.querySelector("h1.feed-header__title")?.textContent,
      author: root.querySelector("p.feed-header__author")?.textContent,
      description: root.querySelector("p.feed-header__desc")?.textContent,
      subscribe: root.querySelector("small.subscribe a:last-child")?.getAttribute("href"),
      episodeCount: episodes.length,
      episodes: [firstEpisode, secondEpisode].map((episode) => ({
        title: episode?.querySelector("a.episode__title")?.textContent,
        href: episode?.querySelector("a.episode__title")?.getAttribute("href"),
        duration: episode?.querySelector("small.episode__duration")?.textContent,
      })),
    }).toEqual({
      back: { text: "← Back", href: "/" },
      header: "feed-header",
      cover: "https://library.example/covers/first.jpg",
      info: "feed-header__info",
      title: "First & Finest",
      author: "Ada Author",
      description: "A narrated collection",
      subscribe: "antennapod-subscribe://library.example/books/first/feed.xml",
      episodeCount: 2,
      episodes: [
        {
          title: "Opening Chapter",
          href: "https://library.example/audio/opening.mp3",
          duration: "0:59",
        },
        {
          title: "Long Chapter",
          href: "https://library.example/audio/long.mp3",
          duration: "1:01:01",
        },
      ],
    });
  });

  test("omits optional podcast metadata and an absent episode duration", async () => {
    // #given
    const document = createUiWindow("https://library.example/books/minimal/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const root = renderPage(document, {
      kind: "podcast",
      title: "Minimal Podcast",
      subscribeUrl: "https://library.example/books/minimal/feed.xml",
      episodes: [{ title: "Only Chapter", href: "https://library.example/audio/only.mp3" }],
    });

    // #then
    expect({
      title: root.querySelector("h1.feed-header__title")?.textContent,
      episode: root.querySelector("a.episode__title")?.textContent,
      optionalMetadataCount: root.querySelectorAll(
        ".feed-header__cover img, .feed-header__author, .feed-header__desc",
      ).length,
      durationCount: root.querySelectorAll(".episode__duration").length,
    }).toEqual({
      title: "Minimal Podcast",
      episode: "Only Chapter",
      optionalMetadataCount: 0,
      durationCount: 0,
    });
  });

  test.each([
    [
      "building",
      { kind: "building" as const, retryAfterMs: 5000 },
      { text: "library is being built", href: null, link: null },
    ],
    [
      "not found",
      { kind: "not-found" as const },
      { text: "podcast not found Back to library", href: "/", link: "Back to library" },
    ],
    [
      "error",
      { kind: "error" as const, message: "Upstream failed", feedUrl: "/broken/feed.xml" },
      {
        text: "Upstream failed Open raw feed",
        href: "/broken/feed.xml",
        link: "Open raw feed",
      },
    ],
  ])("renders the %s page with its message and link", async (_label, page, expected) => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const root = renderPage(document, page);

    // #then
    expect({
      text: root.textContent?.trim(),
      href: root.querySelector("a")?.getAttribute("href") ?? null,
      link: root.querySelector("a")?.textContent ?? null,
    }).toEqual(expected);
  });

  test("sets a title placeholder on every cover, with or without an image", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const list = renderPage(document, {
      kind: "list",
      title: "Library",
      entries: [
        {
          title: "a",
          href: "/browse/books/a/",
          imageUrl: "https://library.example/books/a/cover.jpg",
          subscribeUrl: "https://library.example/books/a/feed.xml",
        },
        { title: "foobar", href: "/browse/books/foobar/" },
      ],
    });

    const podcast = renderPage(document, {
      kind: "podcast",
      title: "foobar",
      subscribeUrl: "https://library.example/books/foobar/feed.xml",
      episodes: [],
    });

    const covers: (HTMLElement | null)[] = [
      ...list.querySelectorAll(".podcast__cover"),
      podcast.querySelector(".feed-header__cover"),
    ];

    // #then
    expect(
      covers.map((cover) => ({
        lqip: cover?.style.getPropertyValue("--lqip"),
        image: cover?.querySelector("img")?.getAttribute("src") ?? null,
        subscribeCount: cover?.closest("li")?.querySelectorAll("small.subscribe").length,
      })),
    ).toEqual([
      {
        lqip: "796972",
        image: "https://library.example/books/a/cover.jpg",
        subscribeCount: 1,
      },
      { lqip: "850280", image: null, subscribeCount: 0 },
      { lqip: "850280", image: null, subscribeCount: undefined },
    ]);
  });

  test("removes a cover image that fails to load and keeps the placeholder", async () => {
    // #given
    const window = createUiWindow("https://library.example/books/a/");
    const { renderPage } = await import(RENDER_MODULE);

    const root = renderPage(window.document, {
      kind: "podcast",
      title: "a",
      imageUrl: "https://library.example/books/a/cover.jpg",
      subscribeUrl: "https://library.example/books/a/feed.xml",
      episodes: [],
    });

    const cover: HTMLElement | null = root.querySelector(".feed-header__cover");

    // #when
    cover?.querySelector("img")?.dispatchEvent(new window.Event("error"));

    // #then
    expect({
      imageCount: cover?.querySelectorAll("img").length,
      lqip: cover?.style.getPropertyValue("--lqip"),
    }).toEqual({ imageCount: 0, lqip: "796972" });
  });

  test("leaves no formatter indentation in rendered list and podcast pages", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPage } = await import(RENDER_MODULE);

    // #when
    const roots = [
      renderPage(document, {
        kind: "list",
        title: "Library",
        opmlUrl: "https://library.example/feed.opml",
        entries: [
          {
            title: "First",
            href: "/browse/books/first/",
            author: "Ada Author",
            description: "A narrated collection",
            imageUrl: "https://library.example/covers/first.jpg",
            subscribeUrl: "https://library.example/books/first/feed.xml",
          },
        ],
      }),
      renderPage(document, {
        kind: "podcast",
        title: "First",
        author: "Ada Author",
        description: "A narrated collection",
        imageUrl: "https://library.example/covers/first.jpg",
        subscribeUrl: "https://library.example/books/first/feed.xml",
        episodes: [
          {
            title: "Opening Chapter",
            href: "https://library.example/audio/opening.mp3",
            duration: 59,
          },
        ],
      }),
    ];

    // #then
    expect(roots.flatMap((root) => blankTextNodes(root))).toEqual([]);
  });
});

describe("formatDuration", () => {
  test.each([
    [59, "0:59"],
    [3661, "1:01:01"],
    [600, "10:00"],
  ])("formats %i seconds as %s", async (seconds, expected) => {
    // #given
    const { formatDuration } = await import(RENDER_MODULE);

    // #when
    const result = formatDuration(seconds);

    // #then
    expect(result).toBe(expected);
  });
});

function blankTextNodes(node: Node): string[] {
  return Array.from(node.childNodes).flatMap((child) =>
    child.nodeType === 3 && child.textContent?.trim() === ""
      ? [child.textContent]
      : blankTextNodes(child),
  );
}
