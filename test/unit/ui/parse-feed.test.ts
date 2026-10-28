import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const PARSER_MODULE = "../../../ui/app/parse-feed.ts";

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

describe("parseOpml", () => {
  test("returns the page title and complete and minimal podcast entries", async () => {
    // #given
    const text = await Bun.file(
      new URL("../../fixtures/feeds/library.opml", import.meta.url),
    ).text();

    const { parseOpml } = await import(PARSER_MODULE);

    // #when
    const result = parseOpml(text);

    // #then
    expect(result).toEqual({
      title: "Audio Library",
      podcasts: [
        {
          title: "First & Finest",
          xmlUrl: "https://library.example/books/first/feed.xml",
          author: "Ada Author",
          description: "A <b>literal</b> description",
          imageUrl: "https://library.example/covers/first.jpg",
        },
        {
          title: "Minimal Podcast",
          xmlUrl: "https://library.example/books/minimal/feed.xml",
        },
      ],
    });
  });
});

describe("parseFeed", () => {
  test("identifies RSS and returns podcast metadata with complete and minimal episodes", async () => {
    // #given
    const text = await Bun.file(
      new URL("../../fixtures/feeds/podcast.xml", import.meta.url),
    ).text();

    const { parseFeed } = await import(PARSER_MODULE);

    // #when
    const result = parseFeed(text);

    // #then
    expect(result).toEqual({
      kind: "podcast",
      model: {
        title: "First & Finest",
        author: "Ada Author",
        description: "A narrated collection",
        imageUrl: "https://library.example/covers/first.jpg",
        episodes: [
          {
            title: "Opening <b>Chapter</b>",
            enclosureUrl: "https://library.example/audio/opening.mp3",
            duration: 59,
            episodeNumber: 1,
          },
          {
            title: "Long Chapter",
            enclosureUrl: "https://library.example/audio/long.mp3",
            episodeNumber: 2,
          },
        ],
      },
    });
  });
});
