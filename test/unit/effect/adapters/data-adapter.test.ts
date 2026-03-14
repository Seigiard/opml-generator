import { describe, test, expect } from "bun:test";
import { adaptDataEvent } from "../../../../src/effect/adapters/data-adapter.ts";
import type { RawDataEvent } from "../../../../src/effect/types.ts";
import type { DeduplicationService } from "../../../../src/context.ts";

const alwaysProcess: DeduplicationService = { shouldProcess: () => true };

describe("adaptDataEvent (data watcher classification)", () => {
  test("entry.xml change creates EntryXmlChanged", () => {
    // #given
    const event: RawDataEvent = { parent: "/data/Fiction/chapter01.mp3/", name: "entry.xml", events: "CLOSE_WRITE" };
    // #when
    const result = adaptDataEvent(event, alwaysProcess);
    // #then
    expect(result?._tag).toBe("EntryXmlChanged");
    if (result?._tag === "EntryXmlChanged") {
      expect(result.parent).toBe("/data/Fiction/chapter01.mp3/");
    }
  });

  test("_entry.xml change creates FolderEntryXmlChanged", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/", name: "_entry.xml", events: "CLOSE_WRITE" }, alwaysProcess);
    expect(result?._tag).toBe("FolderEntryXmlChanged");
    if (result?._tag === "FolderEntryXmlChanged") {
      expect(result.parent).toBe("/data/Fiction/");
    }
  });

  test("MOVED_TO entry.xml creates EntryXmlChanged", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/chapter01.mp3/", name: "entry.xml", events: "MOVED_TO" }, alwaysProcess);
    expect(result?._tag).toBe("EntryXmlChanged");
  });

  test("ignores other data files", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/chapter01.mp3/", name: "cover.jpg", events: "CLOSE_WRITE" }, alwaysProcess);
    expect(result).toBeNull();
  });

  test("ignores feed.xml", () => {
    const result = adaptDataEvent({ parent: "/data/Fiction/", name: "feed.xml", events: "CLOSE_WRITE" }, alwaysProcess);
    expect(result).toBeNull();
  });
});
