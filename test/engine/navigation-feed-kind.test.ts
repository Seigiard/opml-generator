import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { XMLParser } from "fast-xml-parser";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  openEpisodeSynchronization,
  startEpisodeSynchronization,
} from "../../src/engine/composition.ts";
import type { HandlerDeps } from "../../src/context.ts";
import { cleanupTempDir, createTempDir } from "../helpers/fs-helpers.ts";

const AUDIO_FIXTURE = join(import.meta.dir, "../fixtures/audio/tagged.mp3");

const parser = new XMLParser({ ignoreAttributes: false });

const orderedParser = new XMLParser({ preserveOrder: true });

interface OrderedXmlNode {
  [name: string]: OrderedXmlNode[] | undefined;
}

const navigationFeedSchema = Schema.Struct({
  feed: Schema.Struct({
    title: Schema.String,
    link: Schema.String,
    item: Schema.ArrayEnsure(
      Schema.Struct({
        title: Schema.String,
        link: Schema.String,
        description: Schema.String,
        kind: Schema.optional(Schema.String),
      }),
    ),
  }),
});

let root = "";

let filesPath = "";

let dataPath = "";

function realDeps(): HandlerDeps {
  return {
    config: { filesPath, dataPath, port: 3000, reconcileInterval: 0 },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm: (path, options) => rm(path, options),
      readdir: (path) => readdir(path),
      lstat: (path) => lstat(path),
      stat: async (path) => {
        const value = await stat(path);

        return { isDirectory: () => value.isDirectory(), size: value.size };
      },
      exists: async (path) => {
        try {
          await stat(path);

          return true;
        } catch {
          return false;
        }
      },
      writeFile: async (path, content) => {
        await Bun.write(path, content);
      },
      atomicWrite: async (path, content) => {
        const temporaryPath = `${path}.tmp`;
        await Bun.write(temporaryPath, content);
        await rename(temporaryPath, path);
      },
      symlink: (target, path) => symlink(target, path),
      unlink: (path) => unlink(path),
    },
  };
}

async function readNavigationFeed(relativePath = "") {
  const text = await Bun.file(join(dataPath, relativePath, "feed.xml")).text();

  // SAFETY: The generated XML is decoded against navigationFeedSchema before use.
  const parsed = parser.parse(text) as unknown;
  // SAFETY: Only element names and child arrays from preserveOrder output are inspected.
  const ordered = orderedParser.parse(text) as OrderedXmlNode[];
  const feedChildren = ordered.find((node) => node.feed !== undefined)?.feed ?? [];

  const itemFieldOrder = feedChildren
    .filter((node) => node.item !== undefined)
    .map((node) => (node.item ?? []).map((child) => Object.keys(child)[0]));

  return { feed: Schema.decodeUnknownSync(navigationFeedSchema)(parsed).feed, itemFieldOrder };
}

beforeEach(async () => {
  root = await createTempDir("opml-engine-navigation-kind");
  filesPath = join(root, "audiobooks");
  dataPath = join(root, "data");
  await mkdir(filesPath, { recursive: true });
  await mkdir(dataPath, { recursive: true });
});

afterEach(async () => {
  await cleanupTempDir(root);
});

describe("navigation feed child kinds", () => {
  test("labels children from their real source folder contents and keeps item fields ordered", async () => {
    // #given
    await mkdir(join(filesPath, "Mixed Podcast", "Bonus"), { recursive: true });
    await copyFile(AUDIO_FIXTURE, join(filesPath, "Mixed Podcast", "01.mp3"));
    await copyFile(AUDIO_FIXTURE, join(filesPath, "Mixed Podcast", "Bonus", "01.mp3"));
    await mkdir(join(filesPath, "Series Group", "Volume One"), { recursive: true });
    await copyFile(AUDIO_FIXTURE, join(filesPath, "Series Group", "Volume One", "01.mp3"));

    // #when
    await Effect.runPromise(
      Effect.scoped(openEpisodeSynchronization({ ...realDeps(), reconcileIntervalMs: 0 })),
    );
    const { feed, itemFieldOrder } = await readNavigationFeed();

    // #then
    expect({
      title: feed.title,
      link: feed.link,
      items: feed.item,
      itemFieldOrder,
    }).toEqual({
      title: "Catalog",
      link: "/feed.xml",
      items: [
        {
          title: "Mixed Podcast",
          link: "/Mixed%20Podcast/feed.xml",
          description: "2 items",
          kind: "podcast",
        },
        {
          title: "Series Group",
          link: "/Series%20Group/feed.xml",
          description: "1 items",
          kind: "navigation",
        },
      ],
      itemFieldOrder: [
        ["title", "link", "description", "kind"],
        ["title", "link", "description", "kind"],
      ],
    });
  });

  test("updates the parent item kind after direct audio is added and removed", async () => {
    // #given
    const changingFolder = join(filesPath, "Changing", "Nested");
    const directAudio = join(filesPath, "Changing", "direct.mp3");
    await mkdir(changingFolder, { recursive: true });
    await copyFile(AUDIO_FIXTURE, join(changingFolder, "01.mp3"));

    // #when
    const observedItems = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* startEpisodeSynchronization({
            ...realDeps(),
            reconcileIntervalMs: 0,
          });

          yield* live.ready;

          const before = (yield* Effect.promise(() => readNavigationFeed())).feed.item[0];

          yield* Effect.promise(() => copyFile(AUDIO_FIXTURE, directAudio));
          yield* live.notify(["Changing/direct.mp3"]);
          yield* live.awaitCompletion;

          const withDirectAudio = (yield* Effect.promise(() => readNavigationFeed())).feed.item[0];

          yield* Effect.promise(() => rm(directAudio));
          yield* live.notify(["Changing/direct.mp3"]);
          yield* live.awaitCompletion;

          const afterRemoval = (yield* Effect.promise(() => readNavigationFeed())).feed.item[0];

          return [before, withDirectAudio, afterRemoval].map((item) => ({
            description: item?.description,
            kind: item?.kind,
          }));
        }),
      ),
    );

    // #then
    expect(observedItems).toEqual([
      { description: "1 items", kind: "navigation" },
      { description: "2 items", kind: "podcast" },
      { description: "1 items", kind: "navigation" },
    ]);
  });
});
