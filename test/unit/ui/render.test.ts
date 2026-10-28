import { describe, expect, test } from "bun:test";
import type { HTMLElement, Node } from "happy-dom";
import { createUiWindow } from "../../helpers/ui-document.ts";

const RENDER_MODULE = "../../../ui/app/render.ts";

describe("renderPodcastList", () => {
  test("builds the podcast list structure and links to the browser page", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;

    const model = {
      title: "Audio Library",
      podcasts: [
        {
          title: "First & Finest",
          xmlUrl: "https://library.example/books/first/feed.xml",
          author: "Ada Author",
          description: "A narrated collection",
          imageUrl: "https://library.example/covers/first.jpg",
        },
        {
          title: "Root Podcast",
          xmlUrl: "https://library.example/feed.xml",
        },
      ],
    };

    const { renderPodcastList } = await import(RENDER_MODULE);

    // #when
    const root = renderPodcastList(document, model, "https://library.example");
    const items = root.querySelectorAll("li.podcast");
    const first = items[0]!;
    const second = items[1]!;
    const subscribeLinks = first.querySelectorAll("small.subscribe a");

    // #then
    expect({
      root: root.tagName,
      heading: root.querySelector("h1")?.textContent,
      list: root.querySelector("ul")?.className,
      itemCount: items.length,
      cover: {
        src: first.querySelector(".podcast__cover img")?.getAttribute("src"),
        alt: first.querySelector(".podcast__cover img")?.getAttribute("alt"),
      },
      body: first.querySelector("div.podcast__body")?.tagName,
      titleLinks: [first, second].map((item) => ({
        text: item.querySelector("a.podcast__title")?.textContent,
        href: item.querySelector("a.podcast__title")?.getAttribute("href"),
      })),
      author: first.querySelector("small.podcast__author")?.textContent,
      description: first.querySelector("p.podcast__desc")?.textContent,
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
      minimalOptionalElementCount: second.querySelectorAll(
        ".podcast__cover img, .podcast__author, .podcast__desc",
      ).length,
    }).toEqual({
      root: "MAIN",
      heading: "Audio Library",
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
    const { renderPodcastList } = await import(RENDER_MODULE);

    // #when
    const root = renderPodcastList(
      document,
      {
        title: "Library",
        podcasts: [
          {
            title: "<b>x</b>",
            xmlUrl: "https://library.example/books/unsafe/feed.xml",
          },
        ],
      },
      "https://library.example",
    );

    const title = root.querySelector("a.podcast__title");

    // #then
    expect({ text: title?.textContent, childCount: title?.children.length }).toEqual({
      text: "<b>x</b>",
      childCount: 0,
    });
  });
});

describe("renderPodcast", () => {
  test("builds the podcast header, navigation, subscription, and episode list", async () => {
    // #given
    const document = createUiWindow("https://library.example/books/first/").document;

    const model = {
      title: "First & Finest",
      author: "Ada Author",
      description: "A narrated collection",
      imageUrl: "https://library.example/covers/first.jpg",
      episodes: [
        {
          title: "Opening Chapter",
          enclosureUrl: "https://library.example/audio/opening.mp3",
          duration: 59,
          episodeNumber: 1,
        },
        {
          title: "Long Chapter",
          enclosureUrl: "https://library.example/audio/long.mp3",
          duration: 3661,
          episodeNumber: 2,
        },
      ],
    };

    const { renderPodcast } = await import(RENDER_MODULE);

    // #when
    const root = renderPodcast(document, model, "https://library.example/books/first/feed.xml");
    const episodes = root.querySelectorAll("ol.episodes > li.episode");
    const firstEpisode = episodes[0]!;
    const secondEpisode = episodes[1]!;

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
        title: episode.querySelector("a.episode__title")?.textContent,
        href: episode.querySelector("a.episode__title")?.getAttribute("href"),
        duration: episode.querySelector("small.episode__duration")?.textContent,
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
    const { renderPodcast } = await import(RENDER_MODULE);

    // #when
    const root = renderPodcast(
      document,
      {
        title: "Minimal Podcast",
        episodes: [
          {
            title: "Only Chapter",
            enclosureUrl: "https://library.example/audio/only.mp3",
            episodeNumber: 1,
          },
        ],
      },
      "https://library.example/books/minimal/feed.xml",
    );

    // #then
    expect({
      optionalMetadataCount: root.querySelectorAll(
        ".feed-header__cover img, .feed-header__author, .feed-header__desc",
      ).length,
      durationCount: root.querySelectorAll(".episode__duration").length,
    }).toEqual({ optionalMetadataCount: 0, durationCount: 0 });
  });
});

describe("cover placeholder", () => {
  // --lqip values are the FNV-1a vectors pinned in cover-placeholder.test.ts.
  test("sets a title placeholder on every cover, with or without an image", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPodcast, renderPodcastList } = await import(RENDER_MODULE);

    // #when
    const list = renderPodcastList(
      document,
      {
        title: "Library",
        navigation: true,
        podcasts: [
          {
            title: "a",
            xmlUrl: "https://library.example/books/a/feed.xml",
            kind: "podcast",
            imageUrl: "https://library.example/books/a/cover.jpg",
          },
          {
            title: "foobar",
            xmlUrl: "https://library.example/books/foobar/feed.xml",
            kind: "navigation",
          },
        ],
      },
      "https://library.example",
    );

    const page = renderPodcast(
      document,
      { title: "foobar", episodes: [] },
      "https://library.example/books/foobar/feed.xml",
    );

    const covers: (HTMLElement | null)[] = [
      ...list.querySelectorAll(".podcast__cover"),
      page.querySelector(".feed-header__cover"),
    ];

    // #then
    expect(
      covers.map((cover) => ({
        lqip: cover?.style.getPropertyValue("--lqip"),
        image: cover?.querySelector("img")?.getAttribute("src") ?? null,
      })),
    ).toEqual([
      { lqip: "796972", image: "https://library.example/books/a/cover.jpg" },
      { lqip: "850280", image: null },
      { lqip: "850280", image: null },
    ]);
  });

  test("removes a cover image that fails to load and keeps the placeholder", async () => {
    // #given
    const window = createUiWindow("https://library.example/books/a/");
    const { renderPodcast } = await import(RENDER_MODULE);

    const root = renderPodcast(
      window.document,
      { title: "a", imageUrl: "https://library.example/books/a/cover.jpg", episodes: [] },
      "https://library.example/books/a/feed.xml",
    );

    const cover: HTMLElement | null = root.querySelector(".feed-header__cover");

    // #when
    cover?.querySelector("img")?.dispatchEvent(new window.Event("error"));

    // #then
    expect({
      imageCount: cover?.querySelectorAll("img").length,
      lqip: cover?.style.getPropertyValue("--lqip"),
    }).toEqual({ imageCount: 0, lqip: "796972" });
  });
});

describe("template rendering", () => {
  test("leaves no formatter indentation in rendered list and podcast pages", async () => {
    // #given
    const document = createUiWindow("https://library.example/").document;
    const { renderPodcast, renderPodcastList } = await import(RENDER_MODULE);

    // #when
    const roots = [
      renderPodcastList(
        document,
        {
          title: "Library",
          podcasts: [
            {
              title: "First",
              xmlUrl: "https://library.example/books/first/feed.xml",
              author: "Ada Author",
              description: "A narrated collection",
              imageUrl: "https://library.example/covers/first.jpg",
            },
          ],
        },
        "https://library.example",
        "https://library.example/feed.opml",
      ),
      renderPodcast(
        document,
        {
          title: "First",
          author: "Ada Author",
          description: "A narrated collection",
          imageUrl: "https://library.example/covers/first.jpg",
          episodes: [
            {
              title: "Opening Chapter",
              enclosureUrl: "https://library.example/audio/opening.mp3",
              duration: 59,
              episodeNumber: 1,
            },
          ],
        },
        "https://library.example/books/first/feed.xml",
      ),
    ];

    // #then
    expect(roots.flatMap((root) => blankTextNodes(root))).toEqual([]);
  });
});

function blankTextNodes(node: Node): string[] {
  return Array.from(node.childNodes).flatMap((child) =>
    child.nodeType === 3 && child.textContent?.trim() === ""
      ? [child.textContent]
      : blankTextNodes(child),
  );
}

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
