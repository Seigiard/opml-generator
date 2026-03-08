import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { adaptBooksEvent } from "../../../src/effect/adapters/books-adapter.ts";
import { adaptDataEvent } from "../../../src/effect/adapters/data-adapter.ts";
import type { RawBooksEvent, RawDataEvent } from "../../../src/effect/types.ts";
import { DeduplicationService } from "../../../src/effect/services.ts";

const TestDeduplicationService = Layer.succeed(DeduplicationService, {
  shouldProcess: () => Effect.succeed(true),
});

const TestLayer = TestDeduplicationService;

const classifyBooksEvent = async (event: RawBooksEvent) => {
  return Effect.runPromise(Effect.provide(adaptBooksEvent(event), TestLayer));
};

const classifyDataEvent = async (event: RawDataEvent) => {
  return Effect.runPromise(Effect.provide(adaptDataEvent(event), TestLayer));
};

describe("adaptBooksEvent (books watcher classification)", () => {
  describe("file events", () => {
    test("CLOSE_WRITE on mp3 creates AudioFileCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "chapter01.mp3",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("AudioFileCreated");
      if (result?._tag === "AudioFileCreated") {
        expect(result.parent).toBe("/audiobooks/Fiction/");
        expect(result.name).toBe("chapter01.mp3");
      }
    });

    test("MOVED_TO on m4a creates AudioFileCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "chapter01.m4a",
        events: "MOVED_TO",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("AudioFileCreated");
    });

    test("DELETE on ogg creates AudioFileDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "chapter01.ogg",
        events: "DELETE",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("AudioFileDeleted");
      if (result?._tag === "AudioFileDeleted") {
        expect(result.parent).toBe("/audiobooks/Fiction/");
        expect(result.name).toBe("chapter01.ogg");
      }
    });

    test("MOVED_FROM on m4b creates AudioFileDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "audiobook.m4b",
        events: "MOVED_FROM",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("AudioFileDeleted");
    });

    test("ignores non-audio extensions like .md", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "README.md",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });

    test("ignores image files like .jpg", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "cover.jpg",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });

    test("ignores non-audio formats like .epub", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "book.epub",
        events: "CLOSE_WRITE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });

    test("CREATE on file is ignored (wait for CLOSE_WRITE)", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "chapter01.mp3",
        events: "CREATE",
      };

      const result = await classifyBooksEvent(event);

      expect(result).toBeNull();
    });
  });

  describe("directory events", () => {
    test("CREATE,ISDIR creates FolderCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/",
        name: "Fiction",
        events: "CREATE,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderCreated");
      if (result?._tag === "FolderCreated") {
        expect(result.parent).toBe("/audiobooks/");
        expect(result.name).toBe("Fiction");
      }
    });

    test("MOVED_TO,ISDIR creates FolderCreated", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/",
        name: "SciFi",
        events: "MOVED_TO,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderCreated");
    });

    test("DELETE,ISDIR creates FolderDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/",
        name: "OldFolder",
        events: "DELETE,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderDeleted");
      if (result?._tag === "FolderDeleted") {
        expect(result.parent).toBe("/audiobooks/");
        expect(result.name).toBe("OldFolder");
      }
    });

    test("MOVED_FROM,ISDIR creates FolderDeleted", async () => {
      const event: RawBooksEvent = {
        parent: "/audiobooks/",
        name: "MovedAway",
        events: "MOVED_FROM,ISDIR",
      };

      const result = await classifyBooksEvent(event);

      expect(result?._tag).toBe("FolderDeleted");
    });
  });

  describe("supported audio formats", () => {
    const formats = ["mp3", "m4a", "m4b", "ogg"];

    for (const format of formats) {
      test(`recognizes .${format} as audio format`, async () => {
        const event: RawBooksEvent = {
          parent: "/audiobooks/Fiction/",
          name: `chapter01.${format}`,
          events: "CLOSE_WRITE",
        };

        const result = await classifyBooksEvent(event);

        expect(result?._tag).toBe("AudioFileCreated");
      });
    }
  });

  describe("deduplication", () => {
    test("filters duplicate events", async () => {
      let callCount = 0;
      const TestDedupService = Layer.succeed(DeduplicationService, {
        shouldProcess: () =>
          Effect.sync(() => {
            callCount++;
            return callCount === 1;
          }),
      });

      const DedupTestLayer = TestDedupService;

      const event: RawBooksEvent = {
        parent: "/audiobooks/Fiction/",
        name: "chapter01.mp3",
        events: "CLOSE_WRITE",
      };

      const result1 = await Effect.runPromise(Effect.provide(adaptBooksEvent(event), DedupTestLayer));
      const result2 = await Effect.runPromise(Effect.provide(adaptBooksEvent(event), DedupTestLayer));

      expect(result1?._tag).toBe("AudioFileCreated");
      expect(result2).toBeNull();
    });
  });
});

describe("adaptDataEvent (data watcher classification)", () => {
  test("entry.xml change creates EntryXmlChanged", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/chapter01.mp3/",
      name: "entry.xml",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result?._tag).toBe("EntryXmlChanged");
    if (result?._tag === "EntryXmlChanged") {
      expect(result.parent).toBe("/data/Fiction/chapter01.mp3/");
    }
  });

  test("_entry.xml change creates FolderEntryXmlChanged", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/",
      name: "_entry.xml",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result?._tag).toBe("FolderEntryXmlChanged");
    if (result?._tag === "FolderEntryXmlChanged") {
      expect(result.parent).toBe("/data/Fiction/");
    }
  });

  test("MOVED_TO entry.xml creates EntryXmlChanged", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/chapter01.mp3/",
      name: "entry.xml",
      events: "MOVED_TO",
    };

    const result = await classifyDataEvent(event);

    expect(result?._tag).toBe("EntryXmlChanged");
  });

  test("ignores other data files", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/chapter01.mp3/",
      name: "cover.jpg",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result).toBeNull();
  });

  test("ignores feed.xml", async () => {
    const event: RawDataEvent = {
      parent: "/data/Fiction/",
      name: "feed.xml",
      events: "CLOSE_WRITE",
    };

    const result = await classifyDataEvent(event);

    expect(result).toBeNull();
  });
});
