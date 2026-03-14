import { describe, test, expect } from "bun:test";
import { adaptBooksEvent } from "../../../../src/effect/adapters/books-adapter.ts";
import type { RawBooksEvent } from "../../../../src/effect/types.ts";
import type { DeduplicationService } from "../../../../src/context.ts";

const alwaysProcess: DeduplicationService = { shouldProcess: () => true };

describe("adaptBooksEvent (books watcher classification)", () => {
  describe("file events", () => {
    test("CLOSE_WRITE on mp3 creates AudioFileCreated", () => {
      // #given
      const event: RawBooksEvent = { parent: "/audiobooks/Fiction/", name: "chapter01.mp3", events: "CLOSE_WRITE" };
      // #when
      const result = adaptBooksEvent(event, alwaysProcess);
      // #then
      expect(result?._tag).toBe("AudioFileCreated");
      if (result?._tag === "AudioFileCreated") {
        expect(result.parent).toBe("/audiobooks/Fiction/");
        expect(result.name).toBe("chapter01.mp3");
      }
    });

    test("MOVED_TO on m4a creates AudioFileCreated", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "chapter01.m4a", events: "MOVED_TO" }, alwaysProcess);
      expect(result?._tag).toBe("AudioFileCreated");
    });

    test("DELETE on ogg creates AudioFileDeleted", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "chapter01.ogg", events: "DELETE" }, alwaysProcess);
      expect(result?._tag).toBe("AudioFileDeleted");
      if (result?._tag === "AudioFileDeleted") {
        expect(result.parent).toBe("/audiobooks/Fiction/");
        expect(result.name).toBe("chapter01.ogg");
      }
    });

    test("MOVED_FROM on m4b creates AudioFileDeleted", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "audiobook.m4b", events: "MOVED_FROM" }, alwaysProcess);
      expect(result?._tag).toBe("AudioFileDeleted");
    });

    test("ignores non-audio extensions like .md", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "README.md", events: "CLOSE_WRITE" }, alwaysProcess);
      expect(result).toBeNull();
    });

    test("ignores image files like .jpg", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "cover.jpg", events: "CLOSE_WRITE" }, alwaysProcess);
      expect(result).toBeNull();
    });

    test("ignores non-audio formats like .epub", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "book.epub", events: "CLOSE_WRITE" }, alwaysProcess);
      expect(result).toBeNull();
    });

    test("CREATE on file is ignored (wait for CLOSE_WRITE)", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: "chapter01.mp3", events: "CREATE" }, alwaysProcess);
      expect(result).toBeNull();
    });
  });

  describe("directory events", () => {
    test("CREATE,ISDIR creates FolderCreated", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/", name: "Fiction", events: "CREATE,ISDIR" }, alwaysProcess);
      expect(result?._tag).toBe("FolderCreated");
      if (result?._tag === "FolderCreated") {
        expect(result.parent).toBe("/audiobooks/");
        expect(result.name).toBe("Fiction");
      }
    });

    test("MOVED_TO,ISDIR creates FolderCreated", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/", name: "SciFi", events: "MOVED_TO,ISDIR" }, alwaysProcess);
      expect(result?._tag).toBe("FolderCreated");
    });

    test("DELETE,ISDIR creates FolderDeleted", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/", name: "OldFolder", events: "DELETE,ISDIR" }, alwaysProcess);
      expect(result?._tag).toBe("FolderDeleted");
      if (result?._tag === "FolderDeleted") {
        expect(result.parent).toBe("/audiobooks/");
        expect(result.name).toBe("OldFolder");
      }
    });

    test("MOVED_FROM,ISDIR creates FolderDeleted", () => {
      const result = adaptBooksEvent({ parent: "/audiobooks/", name: "MovedAway", events: "MOVED_FROM,ISDIR" }, alwaysProcess);
      expect(result?._tag).toBe("FolderDeleted");
    });
  });

  describe("supported audio formats", () => {
    for (const format of ["mp3", "m4a", "m4b", "ogg"]) {
      test(`recognizes .${format} as audio format`, () => {
        const result = adaptBooksEvent({ parent: "/audiobooks/Fiction/", name: `chapter01.${format}`, events: "CLOSE_WRITE" }, alwaysProcess);
        expect(result?._tag).toBe("AudioFileCreated");
      });
    }
  });

  describe("deduplication", () => {
    test("filters duplicate events", () => {
      // #given
      let callCount = 0;
      const dedup: DeduplicationService = {
        shouldProcess: () => {
          callCount++;
          return callCount === 1;
        },
      };
      const event: RawBooksEvent = { parent: "/audiobooks/Fiction/", name: "chapter01.mp3", events: "CLOSE_WRITE" };
      // #when
      const result1 = adaptBooksEvent(event, dedup);
      const result2 = adaptBooksEvent(event, dedup);
      // #then
      expect(result1?._tag).toBe("AudioFileCreated");
      expect(result2).toBeNull();
    });
  });
});
