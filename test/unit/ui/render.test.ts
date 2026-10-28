import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const RENDER_MODULE = "../../../ui/app/render.ts";

describe("renderPodcastList", () => {
  test("builds the podcast list structure and links to the browser page", async () => {
    // #given
    const document = new Window({ url: "https://library.example/" }).document;

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
        src: first.querySelector("img.podcast__cover")?.getAttribute("src"),
        alt: first.querySelector("img.podcast__cover")?.getAttribute("alt"),
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
        ".podcast__cover, .podcast__author, .podcast__desc",
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
        { text: "Copy RSS", href: "#" },
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
    const document = new Window({ url: "https://library.example/" }).document;
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
    const document = new Window({ url: "https://library.example/books/first/" }).document;

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
      cover: root.querySelector("img.feed-header__cover")?.getAttribute("src"),
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
    const document = new Window({ url: "https://library.example/books/minimal/" }).document;
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
        ".feed-header__cover, .feed-header__author, .feed-header__desc",
      ).length,
      durationCount: root.querySelectorAll(".episode__duration").length,
    }).toEqual({ optionalMetadataCount: 0, durationCount: 0 });
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
